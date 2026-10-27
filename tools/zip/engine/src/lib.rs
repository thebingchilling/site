//! Zopfli, exposed to the zip tool's Web Worker as a tiny C-style ABI.
//!
//! The worker drives one stream at a time: `enc_begin`, then `enc_write`
//! once per slice of input (1 MiB, Zopfli's own master-block size, so
//! slicing costs nothing in ratio and gives the page a progress tick per
//! slice), then `enc_finish`, which leaves the raw DEFLATE stream at
//! `out_ptr()` / `out_len()` for the worker to copy out before the next
//! `enc_begin` frees it.

use std::io::Write;
use std::num::NonZeroU64;
use zopfli::{BlockType, DeflateEncoder, Options};

static mut ENCODER: Option<DeflateEncoder<Vec<u8>>> = None;
static mut OUTPUT: Vec<u8> = Vec::new();

/// Scratch memory the worker copies input into before `enc_write`.
#[no_mangle]
pub extern "C" fn buf_alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

#[no_mangle]
pub unsafe extern "C" fn buf_free(ptr: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(ptr, 0, len));
}

#[no_mangle]
pub unsafe extern "C" fn enc_begin(iterations: u32) {
    OUTPUT = Vec::new();
    let options = Options {
        iteration_count: NonZeroU64::new(iterations.max(1) as u64).unwrap(),
        ..Options::default()
    };
    ENCODER = Some(DeflateEncoder::new(options, BlockType::Dynamic, Vec::new()));
}

/// Returns 0 on success, 1 if there is no stream open or the write failed.
#[no_mangle]
pub unsafe extern "C" fn enc_write(ptr: *const u8, len: usize) -> u32 {
    let enc = match (*std::ptr::addr_of_mut!(ENCODER)).as_mut() { Some(e) => e, None => return 1 };
    match enc.write_all(std::slice::from_raw_parts(ptr, len)) { Ok(()) => 0, Err(_) => 1 }
}

#[no_mangle]
pub unsafe extern "C" fn enc_finish() -> u32 {
    let enc = match (*std::ptr::addr_of_mut!(ENCODER)).take() { Some(e) => e, None => return 1 };
    match enc.finish() {
        Ok(out) => { OUTPUT = out; 0 }
        Err(_) => 1,
    }
}

#[no_mangle]
pub unsafe extern "C" fn out_ptr() -> *const u8 { (*std::ptr::addr_of!(OUTPUT)).as_ptr() }

#[no_mangle]
pub unsafe extern "C" fn out_len() -> usize { (*std::ptr::addr_of!(OUTPUT)).len() }
