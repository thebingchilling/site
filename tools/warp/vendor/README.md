# Vendored: Curve25519 keygen, QR code encoder, AmneziaWG payloads

All three files are vendored (not fetched from a CDN at runtime) so `/tools/warp`
works fully offline for the parts that don't need the network, and never
depends on a third-party host for its crypto or QR rendering.

- `curve25519.js` — the WireGuard project's own browser-side Curve25519
  keypair generator (`window.wireguard.generateKeypair()`), copied verbatim
  from [`lanrat/wireguard-warp-generator`](https://github.com/lanrat/wireguard-warp-generator)
  (`docs/wireguard.js`), itself taken from WireGuard's official web
  configurator. Copyright Jason A. Donenfeld, GPL-2.0. All key generation
  happens locally in the browser — the private key is never sent anywhere.
- `qrcode-generator.js` — renders the finished config as a scannable QR
  code. Source: [`kazuhikoarase/qrcode-generator`](https://github.com/kazuhikoarase/qrcode-generator)
  (`js/dist/qrcode.js`), MIT license.
- `awg-payloads.js` — three real captured WARP QUIC Initial packets used
  as the AmneziaWG `I1` value (`window.WARP_AWG_I1`). Source:
  [`Skiro1/warp-awg-gen`](https://github.com/Skiro1/warp-awg-gen)
  (`internal/awg/cps.go`), MIT license.

To update: re-copy `docs/wireguard.js` from the wireguard-warp-generator
repo, or `js/dist/qrcode.js` from the qrcode-generator repo, at the desired
version/commit, or the `warpCPSPayloads` strings from warp-awg-gen's
`internal/awg/cps.go` into `awg-payloads.js`.
