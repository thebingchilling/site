# Vendored: fflate and Zopfli

Both are vendored (not fetched from a CDN at runtime) so `/tools/zip` works
fully offline and never depends on a third-party host.

## fflate.js

- Source package: [`fflate`](https://github.com/101arrowz/fflate) v0.8.2 (npm), `umd/index.js`
- License: MIT
- Used for: levels Fast, Normal and Best (DEFLATE levels 1, 6 and 9), and
  for inflating every compressed entry again to check it before download.

To update: `npm pack fflate@<version>` and copy `package/umd/index.js` here
as `fflate.js`.

## zopfli.wasm

- Built from `../engine/` — a few lines of Rust over the
  [`zopfli`](https://github.com/zopfli-rs/zopfli) crate v0.8.1, a port of
  Google's [Zopfli](https://github.com/google/zopfli)
- License: Apache-2.0
- Used for: the MAX level

To rebuild (needs Rust with the `wasm32-unknown-unknown` target):

```sh
cd tools/zip/engine
cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/zip_engine.wasm ../vendor/zopfli.wasm
```
