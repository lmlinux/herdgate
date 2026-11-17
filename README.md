# herdr-web

**A minimal web client for [herdr-core](https://github.com/herdrdev/herdr-core)**: persistent terminals and a live agent fleet panel in the browser, rendered by [ghostty-web](https://github.com/coder/ghostty-web) — Ghostty's VT100 emulator compiled to WebAssembly.

```
Browser (ghostty-web rendering)
   │  WebSocket (binary = hc framed frames / text = JSON-RPC)
   ▼
gateway (this repo, single Node process: auth + pass-through)
   │  hc connect child process (stdin/stdout, framed protocol)
   ▼
herdr-core ── persistent terminals running Claude Code / Codex / dev servers / anything
              └─ ssh box hc connect reaches a remote machine's core
```

## What it is — and what it isn't

The herdr ecosystem already ships web and mobile clients built around a personal setup (paired devices, push notifications, private-network front doors). This project deliberately does not compete there. It is the smallest implementation that speaks the **protocol layer** end to end, useful as:

- **A base for internal services** — one ~300-line gateway plus a build-free static frontend you can reshape into what your team actually needs:
  - *Read-only spectating* (observe attach): let colleagues watch an agent work or debug in their browser — no accounts, no input rights, nothing to install
  - *Internal sandbox*: hand out shells or throwaway tool terminals without SSH access or client installs
  - *Status panel*: OSC 7501 working / blocked / done lamps — "who is waiting on a human" at a glance
- **A reference implementation** — the framed wire protocol (channels, CREDIT flow control, RESIZE, first paint) in a few hundred lines of commented JavaScript
- **A trimmable component** — no bundler, no framework, no database; the gateway passes frames through untouched

## Quick start

Requires herdr-core (`hc`) on this machine.

```bash
npm install
npm start          # http://127.0.0.1:8787/  (default HC_CONNECT="hc connect")
```

To reach a remote machine's core:

```bash
HC_CONNECT="ssh box hc connect" npm start
```

Environment variables: `PORT` (default 8787), `HOST` (default 127.0.0.1), `HC_CONNECT`.

## Features (MVP)

- Terminal list sidebar driven by the `events.subscribe` stream (created / finished / status / title / foreground…), colored by OSC 7501 status
- Click to attach: first paint plus incremental bytes into ghostty-web; keyboard → DATA frames; `onResize` → RESIZE frames; window focus → FOCUS frames
- **Backpressure preserved end to end**: every DATA frame is credited right after being consumed; a viewer that falls behind gets a fresh repaint, decided by the core
- 👁 observe mode: read-only attach (`terminal.attach {observe:true}`) — no input, no resizing
- ＋ new terminal (`terminal.run`) / kill (`terminal.kill`)
- Auth: per-run random token injected into the same-origin page; `/ws` checks the token and rejects cross-origin handshakes; loopback bind by default

## Security boundaries (read this)

herdr-core is a **single-user trust model** (a local Unix socket with 0700 permissions, no API password). Anyone who can reach its API can run commands with your access. Therefore:

- The gateway binds `127.0.0.1` by default; a non-loopback bind is protected by a single token — **do not expose it to the public internet**
- For internal use: put it behind your existing entry point (Tailscale / VPN / reverse proxy with TLS); treat the token as a second door
- Multi-user authorization is deliberately absent from core — building it at the gateway layer is exactly where the product value lives

## Layout

```
server/gateway.mjs   # WS ↔ hc connect bridge: framed-mode handshake, frame reassembly, auth, static assets
web/                 # build-free frontend: index.html / app.js / app.css
```

## Protocol notes (for anyone hacking on this)

- A connection starts in plain mode: one JSON-RPC message per line; `hello {"framed":true}` switches it to binary frames after its reply
- Frame: `[channel u32 LE][kind u8][len u32 LE][payload]`, payload ≤ 16 MiB
- Channel 0 carries JSON-RPC; the channel returned by `terminal.attach` carries the first paint plus raw program output (DATA) from the core, and keys (DATA), size (RESIZE), focus (FOCUS), credit (CREDIT), goodbye (CLOSE) from the viewer
- `events.subscribe` returns its own channel in framed mode; notifications arrive as JSON lines; a subscriber that falls behind gets `missed` with a fresh snapshot (replace your state wholesale)
- Flow control: a stream starts with 256 KiB of credit; the viewer returns credit for consumed bytes; a viewer more than 4 MiB behind receives a fresh repaint instead of the backlog

## License

- Code in this repo: MIT
- Dependencies: ghostty-web (MIT), ws (MIT); herdr-core (Apache-2.0) is an external runtime, not vendored
