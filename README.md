# herdgate

**The instant observation window for [herdr-core](https://github.com/herdrdev/herdr-core)** — paste a URL, click a terminal, watch and interact. No login, no navigation, no learning curve. Terminal rendering by [ghostty-web](https://github.com/coder/ghostty-web) (Ghostty's VT100 emulator compiled to WebAssembly). Protocol handling by [herdview](https://www.npmjs.com/package/herdview) (HerdConnection + HerdView).

Full-featured workspaces exist ([shepherdr](https://herdr.dev) manages spaces, tasks, chats, automation). herdgate is the one-purpose tool for when you just need to **see what's running and type into it** — the screwdriver, not the Swiss Army knife.

```
Browser (ghostty-web rendering via herdview)
   │  WebSocket (binary = hc framed frames / text = JSON-RPC)
   ▼
gateway (this repo, single Node process: auth + pass-through)
   │  hc connect child process (stdin/stdout, framed protocol)
   ▼
herdr-core ── persistent terminals running Claude Code / Codex / dev servers / anything
              └─ ssh box hc connect reaches a remote machine's core
```

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

Environment variables: `PORT` (default 8787), `HOST` (default 127.0.0.1), `HC_CONNECT`, `HERDR_WEB_TOKEN` (optional for loopback, required otherwise), and `HERDR_WEB_RO_TOKEN` (optional read-only token).

### Dual-token: full access + read-only observation

One gateway instance, two permission levels:

```bash
PORT=8791 HOST=0.0.0.0 \
  HERDR_WEB_TOKEN='your-full-access-secret' \
  HERDR_WEB_RO_TOKEN='read-only-token-for-colleagues' \
  npm start
```

- `?token=<HERDR_WEB_TOKEN>` — full access: attach, type, create, kill
- `?token=<HERDR_WEB_RO_TOKEN>` — read-only: forced observe mode, no input, `+ New` and `kill` hidden, badge shows "read-only"

Generate tokens with `openssl rand -hex 12`. No CLI, no config file, no registration.

## Features

**Terminal interaction**
- Terminal list sidebar, colored by OSC 7501 status (idle/working/blocked/done/error)
- Click to attach: first paint + incremental bytes; keyboard input; resize; window focus tracking
- 👁 Observe mode: read-only attach — no input, no resizing (per-tab toggle, or locked via RO token)
- ＋ New terminal / kill terminal
- **Auto-reconnect**: WebSocket drops are detected and reconnected with exponential backoff (via herdview's HerdConnection); terminal state is re-established automatically

**Sidebar UX**
- Finished terminals hidden by default; "show history" toggle reveals them (dimmed)
- "clear finished" button removes all completed terminals from the session
- Collapsible sidebar (◀/▶ edge toggle) for full-width terminal viewing
- Terminals auto-numbered by herdr-core (t18, t19…) — no duplicate names

**Protocol**
- Backpressure preserved end to end: DATA frames credited after consumption; slow viewers get fresh repaints
- Framed protocol (channels, CREDIT, RESIZE, FOCUS) handled entirely by [herdview](https://www.npmjs.com/package/herdview)
- Cross-origin WebSocket handshakes rejected

**Auth**
- Loopback: per-run random token (auto-generated, printed to console)
- Non-loopback: requires explicit `HERDR_WEB_TOKEN`; optional `HERDR_WEB_RO_TOKEN` for read-only
- Timing-safe token comparison; Host header validation (DNS-rebinding defense)

## Architecture

```
herdgate/
├── server/gateway.mjs    # Node gateway: auth, static files, hc connect bridge
└── web/                   # Build-free frontend (uses herdview via import map)
    ├── index.html         # Shell + import map + token injection
    ├── app.js             # UI logic (sidebar, toolbar, container)
    └── app.css            # Styling
```

The gateway serves herdview's files at `/vendor/herdview.js` (from a sibling directory in dev, or `node_modules` when installed via npm).

## Security boundaries

- herdr-core is a single-user trust model: anyone who can reach its API can run commands. The gateway adds token auth, but is not a multi-user authorization system.
- Default bind is `127.0.0.1`. Non-loopback binds require `HERDR_WEB_TOKEN` and should sit behind TLS.
- The read-only token limits the browser UI, but the underlying hc protocol does not distinguish token roles — a determined user with the RO token and protocol knowledge could craft their own frames. For true isolation, use separate herdr-core sessions.

## Roadmap

- **herdview** — the embeddable pane component extracted from this repo, available as a separate npm package with TypeScript declarations

## License

MIT
