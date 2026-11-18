# herdgate

**The instant observation window for [herdr-core](https://github.com/herdrdev/herdr-core)** — paste a URL, click a terminal, watch and interact. No login, no navigation, no learning curve. Terminal rendering by [ghostty-web](https://github.com/coder/ghostty-web) (Ghostty's VT100 emulator compiled to WebAssembly).

Full-featured workspaces exist ([shepherdr](https://herdr.dev) manages spaces, tasks, chats, automation). herdgate is the one-purpose tool for when you just need to **see what's running and type into it** — the screwdriver, not the Swiss Army knife.

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

The herdr ecosystem already ships orchestrators with their own consoles — fleet management, web panels, TUIs, MCP servers. This project deliberately does not compete there: it is not an orchestrator and manages nothing. It is the smallest implementation that speaks the **runtime layer** end to end — a window onto every terminal in herdr-core, no matter which orchestrator (or human) started it. Useful as:

- **A component for orchestrator consoles** — the ghostty-web pane and protocol client can be embedded into any web UI that needs a live terminal view (orchestrator panels typically lack terminal rendering)
- **A base for read-only internal services** — a small gateway plus a build-free static frontend you can reshape into what your team actually needs:
  - *Read-only spectating* (observe attach): let colleagues watch an agent work or debug in their browser — no accounts, no input rights, nothing to install
  - *Internal sandbox*: hand out shells or throwaway tool terminals without SSH access or client installs
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

Environment variables: `PORT` (default 8787), `HOST` (default 127.0.0.1), `HC_CONNECT`, and `HERDR_WEB_TOKEN` (optional for loopback, required otherwise).

To let other machines on a trusted network reach the UI:

```bash
HOST=0.0.0.0 HERDR_WEB_TOKEN='replace-with-a-long-random-secret' npm start
# Open http://SERVER:8787/?token=replace-with-a-long-random-secret
```

## Features (MVP)

- Terminal list sidebar driven by the `events.subscribe` stream (created / finished / status / title / foreground…), colored by OSC 7501 status
- Click to attach: first paint plus incremental bytes into ghostty-web; keyboard → DATA frames; `onResize` → RESIZE frames; window focus → FOCUS frames
- **Backpressure preserved end to end**: every DATA frame is credited right after being consumed; a viewer that falls behind gets a fresh repaint, decided by the core
- 👁 observe mode: read-only attach (`terminal.attach {observe:true}`) — no input, no resizing
- ＋ new terminal (`terminal.run`) / kill (`terminal.kill`)
- Auth: loopback uses a per-run WebSocket token; non-loopback requires an explicit `HERDR_WEB_TOKEN` for both the page and `/ws`; cross-origin handshakes are rejected

## Security boundaries (read this)

herdr-core is a **single-user trust model** (a local Unix socket with 0700 permissions, no API password). Anyone who can reach its API can run commands with your access. Therefore:

- The gateway binds `127.0.0.1` by default. Its random local token is a WebSocket handshake check, **not user authentication**; loopback Host headers are checked to limit DNS rebinding.
- A non-loopback bind refuses to start without `HERDR_WEB_TOKEN`. The token-bearing page is then available only at `/?token=...`; use TLS so the secret and terminal traffic are not visible in transit.
- **Do not expose it to the public internet.** For internal use, put it behind Tailscale / VPN or an access-controlled TLS reverse proxy. Anyone who obtains the token has full terminal access; this is not a multi-user authorization system.
- Multi-user authorization is deliberately absent from core — building it at the gateway layer is exactly where the product value lives

## Test

The automated suite uses a fake framed core and needs only Node.js 20+; it does not touch your real terminals:

```bash
npm ci
npm run check
npm test
```

Covered: CLI help, occupied-port diagnostics, HTTP/WebSocket authentication, Origin and loopback Host checks, delayed handshakes, fragmented core frames, missing `hc`, and incremental JSON parsing (including split UTF-8 and frame-delimited JSON without a trailing newline).

## Layout

```
server/gateway.mjs   # WS ↔ hc connect bridge: framed-mode handshake, frame reassembly, auth, static assets
web/                 # build-free frontend and incremental JSON-lines parser
test/                # Node test suite and fake core fixture
```

## Protocol notes (for anyone hacking on this)

### Browser ↔ gateway

- Text WebSocket frames are JSON-RPC requests. The gateway wraps each request in a channel 0 DATA frame; JSON-RPC responses arrive in channel 0 binary frames.
- Browser clients wait for the gateway's `{"type":"gateway","event":"ready"}` text message before sending RPC; messages received earlier are discarded.
- Binary WebSocket frames are opaque pass-through frames for attach streams. The page handles program output and input (DATA), flow control (CREDIT), size (RESIZE), focus (FOCUS), and goodbye (CLOSE).
- The browser neither needs nor sends `hello`: the gateway has already completed the framed-mode handshake with herdr-core before announcing `ready`.

### Gateway ↔ herdr-core

- Each `hc connect` connection starts in plain mode with one JSON-RPC message per line. The gateway sends `hello {"framed":true}` and switches to binary frames after its reply.
- Frame: `[channel u32 LE][kind u8][len u32 LE][payload]`, payload ≤ 16 MiB.
- Channel 0 carries JSON-RPC. The channel returned by `terminal.attach` carries the first paint plus raw program output (DATA) from the core, and keys (DATA), size (RESIZE), focus (FOCUS), credit (CREDIT), goodbye (CLOSE) from the viewer.
- `events.subscribe` returns its own channel in framed mode; notifications arrive as JSON lines; a subscriber that falls behind gets `missed` with a fresh snapshot (replace your state wholesale).
- Flow control: a stream starts with 256 KiB of credit; the viewer returns CREDIT for consumed bytes to provide backpressure; a viewer more than 4 MiB behind receives a fresh repaint instead of the backlog.

## Roadmap

- **herdview** — an embeddable pane component: the terminal view from this
  repo, extracted as a standalone package that orchestrator consoles and
  internal dashboards can embed. The name is reserved for that component;
  it will ship separately once there is a real component to ship.

## License

- Code in this repo: MIT
- Dependencies: ghostty-web (MIT), ws (MIT); herdr-core (Apache-2.0) is an external runtime, not vendored
