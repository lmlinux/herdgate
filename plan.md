# Plan: connect to every local herdr-core

## Discovery

- With no explicit `HC_CONNECT`, scan the invoking user's
  `$XDG_RUNTIME_DIR/herdr-core` (falling back to `/run/user/<uid>/herdr-core`;
  override with `HC_SOCKET_DIR`) for API sockets named `<core>.sock`. Accept
  arbitrary core names; none are hardcoded. Exclude `*.holder.*.sock` and
  non-socket entries. The live machine confirms its `default.sock` and
  `shepherdr.sock` accept API connections; holder sockets are internal.
- Optionally set `HC_CORES=default,shepherdr` to use a configured list instead
  of scanning, with the default `hc connect` command. Explicit `HC_CONNECT`
  always retains single-upstream behavior, including `ssh box hc connect`, and
  is rejected when combined with `HC_CORES`.
- Re-scan every 5 seconds and expose the result at authenticated `GET
  /api/cores`. The browser polls it, so newly appearing cores join without a
  gateway restart. Socket scanning is cheap and needs no core cooperation, but
  stale sockets remain listed and reconnect indefinitely until their socket
  files disappear; configured lists trade automatic discovery for deterministic
  remote/custom setups.

## Connections and protocol

- Keep the existing WebSocket framing unchanged. Each browser/core pair gets
  its own `hc connect --session <core>` child and its own herdview
  `HerdConnection`, selected by `?core=<name>` on `/ws`. Omitting `core` keeps
  legacy single-core behavior and selects the default/first discovered core.
- This gives N children per browser for N cores. Independent channel numbers,
  RPC IDs, CREDIT, RESIZE, CLOSE and terminal addresses therefore need no
  rewriting or cross-core multiplexing. Existing token, Origin and Host checks
  remain on every connection.
- Validate requested core names against the current discovered/configured set;
  never accept arbitrary session names or shell command fragments.

## Browser

- Poll `/api/cores`, open one labeled connection per core, and merge terminal
  snapshots using the composite key `<core>:<address>` so equal addresses such
  as `t2` cannot collide.
- Label every sidebar row and the active terminal title with its core. Bind each
  `HerdView` to its terminal's own connection. Route attach, input, resize,
  kill, clear-finished and new-terminal operations to the appropriate core; new
  terminals use the active core, falling back to `default`.
- Remove terminals and cached views for a core that disappears. Keep healthy
  cores usable when another core fails or reconnects.

## Non-goals

- Connect to herdr-core only. The herdr TUI world and its sockets under
  `~/.config/herdr` are not herdr-core API endpoints: do not discover, label or
  bridge them as cores. TUI access belongs to existing dedicated tools.
- Remote enumeration over SSH is out of scope; explicit remote `HC_CONNECT`
  keeps its existing single-core behavior.

## Tests and verification

- Extend the fake core to report its `--session` and return distinct terminal
  records. Test socket filtering/discovery (including later arrivals), core
  validation, two-core aggregation without address collisions, per-core RPC and
  frame routing, full-access input and resize, and legacy `HC_CONNECT`.
- Run the existing suite plus syntax checks.
- Start a gateway against throwaway herdr-core sessions, list and attach to
  terminals from both `default` and `shepherdr`, and capture the combined,
  core-labeled browser view. Verify input, resize, create and kill only against
  those throwaway sessions, never the live ones.
- Update the public README with discovery, configuration, connection model and
  the no-restart behavior/limitations.
