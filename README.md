# herdgate

**The instant terminal window for every local [herdr-core](https://github.com/herdrdev/herdr-core)** — paste a URL, click a terminal, watch and interact. One page combines terminals from all herdr-core instances in the invoking user's runtime directory, labeled by core. No login, no navigation, no learning curve. Terminal rendering by [ghostty-web](https://github.com/coder/ghostty-web) (Ghostty's VT100 emulator compiled to WebAssembly). Protocol handling by [herdview](https://www.npmjs.com/package/herdview) (HerdConnection + HerdView).

Full-featured workspaces exist — [shepherdr](https://herdr.dev) (spaces, tasks, chats, automation), herdr's official Windows app, or anything else built on `hc`. They don't compete with herdgate: every herdr client drives the **same** herdr-core terminals, so one herdgate window connects to and interacts across all of them. Create work in whichever client you like; watch it — and type into it — through herdgate. The screwdriver that lives next to everyone's Swiss Army knife.

```
Browser (ghostty-web rendering via herdview)
   │  WebSocket per core (binary = hc framed frames / text = JSON-RPC)
   ▼
gateway (this repo, single Node process: discovery + auth + pass-through)
   ├─ hc connect --session <core A> child (stdin/stdout, framed protocol)
   └─ hc connect --session <core B> child
   ▼
local herdr-cores ── persistent terminals running Claude Code / Codex / dev servers / anything
                    (created by any client: Windows app, shepherdr, hc CLI — all visible here)
                     └─ explicit HC_CONNECT="ssh box hc connect" retains single-core remote mode
```

## Quick start

Requires herdr-core (`hc`) on this machine.

```bash
npm install
npm start          # http://127.0.0.1:8787/  (discovers every local herdr-core)
```

To reach one remote machine's core in the existing single-core mode:

```bash
HC_CONNECT="ssh box hc connect" npm start
```

Environment variables:

- `PORT` (default `8787`) and `HOST` (default `127.0.0.1`)
- `HC_CONNECT` — explicit single-core upstream command, including SSH; cannot be combined with `HC_CORES` (default command: `hc connect`)
- `HC_CORES` — optional comma-separated core names, instead of socket discovery; uses the default `hc connect` command and appends `--session <name>` for each browser/core connection
- `HC_SOCKET_DIR` — override the local discovery directory
- `HERDR_WEB_TOKEN` — optional for loopback, required otherwise; grants full terminal access

### Local multi-core discovery

With no explicit `HC_CONNECT` or `HC_CORES`, herdgate scans the invoking user's `$XDG_RUNTIME_DIR/herdr-core` (falling back to `/run/user/<uid>/herdr-core`). Every public `<name>.sock` API socket becomes a core named `<name>`; internal `<name>.holder.<hash>.sock` files and non-socket entries are ignored. Core names are discovered generically, not hardcoded.

The browser refreshes discovery every 5 seconds. A core that appears later joins the same page without a gateway restart; a disappeared core and its cached views are removed. A stale socket remains listed and its connection keeps retrying until the socket file disappears. Socket scanning is automatic and local-only; use `HC_CORES` for a deterministic configured list.

Each core gets an independent `hc connect --session <name>` child and browser `HerdConnection`. Terminal addresses, channel numbers, RPC IDs, flow-control credits, and attachments therefore stay scoped to their own core, with no protocol rewriting. Attach, input, resize, kill, and clear-finished all use the selected terminal's core. `+ New` uses the active core, falling back to `default` or the first available core.

**Scope:** herdgate connects to herdr-core only. herdr TUI sockets under `~/.config/herdr` are a different world, are not discovered, and are intentionally not bridged. Remote discovery over SSH is also out of scope; explicit remote `HC_CONNECT` remains single-core.

### Full-access token

For a non-loopback bind, set one explicit secret:

```bash
PORT=8791 HOST=0.0.0.0 \
  HERDR_WEB_TOKEN='your-full-access-secret' \
  npm start
```

Open `http://<host>:<port>/?token=<HERDR_WEB_TOKEN>`. Anyone with this URL can attach, type, create, and kill terminals. Generate tokens with `openssl rand -hex 12`. No CLI, no config file, no registration.

## Features

**Terminal interaction**
- Combined terminal list across every discovered local core, with a core label on every row and the active title
- Terminal addresses are core-scoped: identical names such as `t2` on two cores remain independent
- Click to attach: first paint + incremental bytes; keyboard input; resize; window focus tracking
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

**CJK terminal rendering**
- Cell widths follow the system CJK glyph advance so mixed Chinese, Japanese, Korean, and ASCII output stays on the terminal grid.
- For the best dual-width rendering, install Sarasa Mono SC or Noto Sans Mono CJK SC. herdgate uses system fonts only and downloads no font assets; NSimSun is preferred on Windows when the other fonts are unavailable.

**Auth**
- Loopback: per-run random token (auto-generated, printed to console)
- Non-loopback: requires explicit `HERDR_WEB_TOKEN`
- Timing-safe token comparison; Host header validation (DNS-rebinding defense)

## Architecture

```
herdgate/
├── server/gateway.mjs    # Node gateway: auth, discovery API, static files, per-core hc bridge
├── server/cores.mjs      # Per-user socket discovery and configured core lists
└── web/                  # Build-free frontend (uses herdview via import map)
    ├── index.html        # Shell + import map + token injection
    ├── app.js            # Multi-core sidebar, toolbar, connection/view routing
    └── app.css           # Styling
```

The gateway serves herdview's files at `/vendor/herdview.js` (from a sibling directory in dev, or `node_modules` when installed via npm).

## Security boundaries

- herdr-core is a single-user trust model: anyone who can reach its API can run commands. The gateway adds token auth, but is not a multi-user authorization system.
- Every authenticated connection has full terminal access: attach, input, resize, create, kill, and clear-finished. Share `HERDR_WEB_TOKEN` only with people who may control these terminals.
- Default bind is `127.0.0.1`. With no configured token, loopback uses a fresh per-run WebSocket token and serves the page without a query parameter. Setting `HERDR_WEB_TOKEN` makes the token-bearing page URL mandatory.
- Non-loopback binds require `HERDR_WEB_TOKEN` and should sit behind TLS. The same secret protects the page, discovery API, and WebSocket upgrade.
- Token comparison is timing-safe. The gateway validates Host headers and rejects cross-origin browser WebSocket handshakes.
- Requested core names must be in the current discovered or configured set. Explicit `HC_CONNECT` retains its single-upstream behavior.

## Roadmap

- **herdview** — the embeddable pane component extracted from this repo, available as a separate npm package with TypeScript declarations

## License

MIT
