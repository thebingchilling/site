/* ═══════════════════════════════════════════════════════════════════════
   Zip tool — compression worker.

   The page keeps a small pool of these and hands each one a File (or a
   slice of one) at a time; the bytes are read here, so the page never
   holds them. Three jobs:

     measure   compressed sizes of some slices at levels 1, 6 and 9, for
               the size preview
     zmeasure  the same slices through Zopfli, for the MAX preview
     compress  one whole file at one level, returning the bytes that go
               into the zip — already checked: every DEFLATE result is
               inflated again here and must give back the same length and
               CRC-32 as the original, or the job fails rather than hand
               the page something that wouldn't unzip byte for byte

   Messages in:  { id, op, ... }
   Messages out: { id, progress } while working, then { id, result } or
                 { id, error }.
   ═══════════════════════════════════════════════════════════════════════ */
"use strict";

importScripts("vendor/fflate.js");

/* ── CRC-32 (the zip one: reflected 0xEDB88320) ── */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(bytes) {
  let c = -1;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* ── Zopfli (Rust → WebAssembly, see vendor/README.md) ── */
let zopfliPromise = null;
function loadZopfli() {
  if (!zopfliPromise) {
    zopfliPromise = (async () => {
      const res = await fetch("vendor/zopfli.wasm");
      if (!res.ok) throw new Error("Couldn't load the MAX engine (" + res.status + ").");
      const { instance } = await WebAssembly.instantiate(await res.arrayBuffer(), {});
      return instance.exports;
    })();
    zopfliPromise.catch(() => { zopfliPromise = null; });
  }
  return zopfliPromise;
}

const ZOPFLI_ITERATIONS = 15;
// Zopfli's own master-block size: it compresses its input in 1 MiB pieces
// anyway (carrying the 32 KiB window across), so feeding it that much at
// a time costs nothing in ratio and gives a progress tick per piece.
const ZOPFLI_SLICE = 1 << 20;

async function zopfliDeflate(bytes, onProgress) {
  const z = await loadZopfli();
  z.enc_begin(ZOPFLI_ITERATIONS);
  for (let off = 0; off < bytes.length; off += ZOPFLI_SLICE) {
    const piece = bytes.subarray(off, off + ZOPFLI_SLICE);
    const ptr = z.buf_alloc(piece.length);
    // memory.buffer is re-read after every call: an allocation can grow
    // it, which detaches any view taken before.
    new Uint8Array(z.memory.buffer, ptr, piece.length).set(piece);
    const failed = z.enc_write(ptr, piece.length);
    z.buf_free(ptr, piece.length);
    if (failed) throw new Error("The MAX engine failed while compressing.");
    if (onProgress) onProgress(off + piece.length);
  }
  if (z.enc_finish()) throw new Error("The MAX engine failed to finish.");
  return new Uint8Array(z.memory.buffer, z.out_ptr(), z.out_len()).slice();
}

/* ── Reading ── */
async function readBytes(blob, start, end) {
  const part = start === undefined ? blob : blob.slice(start, end);
  return new Uint8Array(await part.arrayBuffer());
}

/* ── Jobs ── */
const LEVELS = [1, 6, 9];

// For each slice: its length and its compressed size at each level, plus
// how long each level took over all of them, for the time estimates.
async function measure(msg) {
  const out = { slices: [], ms: { 1: 0, 6: 0, 9: 0 } };
  for (const [start, end] of msg.ranges) {
    const bytes = await readBytes(msg.blob, start, end);
    const row = { length: bytes.length, sizes: {} };
    for (const level of LEVELS) {
      const t = performance.now();
      row.sizes[level] = fflate.deflateSync(bytes, { level }).length;
      out.ms[level] += performance.now() - t;
    }
    out.slices.push(row);
  }
  return out;
}

async function zmeasure(msg) {
  const out = { slices: [], ms: 0 };
  for (const [start, end] of msg.ranges) {
    const bytes = await readBytes(msg.blob, start, end);
    const t = performance.now();
    const z = await zopfliDeflate(bytes);
    out.ms += performance.now() - t;
    out.slices.push({ length: bytes.length, zopfli: z.length, best: fflate.deflateSync(bytes, { level: 9 }).length });
  }
  return out;
}

// Anything that DEFLATE can't get at least 1% smaller at level 9 isn't
// worth a Zopfli pass: photos, video, audio, other archives. Zopfli's
// gain on those is a rounding error and it would take minutes to find it.
const NOT_WORTH_ZOPFLI = 0.99;

async function compress(msg, post) {
  const bytes = await readBytes(msg.blob);
  const crc = crc32(bytes);
  const size = bytes.length;
  let method = 0;
  let data = bytes;

  if (msg.level !== 0) {
    let best = fflate.deflateSync(bytes, { level: msg.level === "max" ? 9 : msg.level });
    if (msg.level === "max" && best.length < size * NOT_WORTH_ZOPFLI) {
      const z = await zopfliDeflate(bytes, (done) => post({ progress: done }));
      if (z.length < best.length) best = z;
    }
    // Stored whenever compressing didn't help, so no file ever comes out
    // bigger than it went in (beyond the zip's own few dozen header bytes).
    if (best.length < size) {
      const back = fflate.inflateSync(best, { out: new Uint8Array(size) });
      if (back.length !== size || crc32(back) !== crc) {
        throw new Error("A compressed file didn't unzip back to the original, so it was refused.");
      }
      method = 8;
      data = best;
    }
  }

  // A fresh buffer that can be transferred without detaching anything
  // else (a deflate result can be a view onto a larger one).
  const copy = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data : data.slice();
  return { crc, size, method, data: copy.buffer };
}

self.onmessage = async (e) => {
  const msg = e.data;
  const post = (body, transfer) => self.postMessage(Object.assign({ id: msg.id }, body), transfer || []);
  try {
    let result;
    if (msg.op === "measure") result = await measure(msg);
    else if (msg.op === "zmeasure") result = await zmeasure(msg);
    else if (msg.op === "compress") result = await compress(msg, post);
    else throw new Error("unknown job " + msg.op);
    post({ result }, result && result.data ? [result.data] : []);
  } catch (err) {
    const message = err && err.name === "NotReadableError"
      ? "A file couldn't be read. It may have been moved or changed since you chose it."
      : err instanceof RangeError
        ? "A file is too large to compress in a browser tab."
        : String((err && err.message) || err);
    post({ error: message });
  }
};
