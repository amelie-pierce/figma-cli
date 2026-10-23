---
title: Make file selection limits and the filesystem bridge
description: Why editor-based Make commands refuse deep files, and how read/replace/import/verify/remove reach any file in the open session's sandbox working copy through Make's own filesystem socket.
date: 2026-10-13
---

Updated 2026-10-24: current Make reconnects identify the workspace through `workspace/ensure`; capture also supports the legacy provisioning handshake.
Updated 2026-10-14: the project root `code` may be listed (only listed) for [status.md](status.md); Make never answers a listing of a missing folder.
Updated 2026-10-13: the bridge reaches the session's sandbox working copy, while the new git-mode durable path uses Make's client VFS; see [persistence.md](persistence.md).

# Make file selection limits and the filesystem bridge

Make source commands reach a file in one of two ways.

## Editor path: limited by the file-tree viewport

`diagnostics`, and `read` only as a fallback, select the file's row in the virtualized file tree and read the CodeMirror document.

- The tree is DOM-only, so an unmounted ancestor row cannot be proven. Selection therefore requires every ancestor folder and the file to be rendered together, and refuses otherwise (`src/make-tree.js:331`, `src/make-tree.js:206`). On the AtomicAUI-6.0 project this refused 38 of 112 files at a 1800x1092 window (for example `src/components/Fieldset.tsx`).
- Markdown opens as a rendered preview with no CodeMirror editor, so an editor read waits for an editor that never appears and times out (`src/make-client.js:303`; observed live on `guidelines/Guidelines.md`, 2026-10-13).

## Filesystem bridge: any depth, any text file

`read`, `replace`, `create`/`import`, `verify` and `remove` send Make's own `fs/file/read|write|delete` messages on the page's existing authenticated WebSocket (`src/make-rpc.js:112`, `src/make-client.js:436`, `src/make-client.js:851`, `src/make-client.js:883`). No tree selection is involved, so depth and file type do not matter. `make drift` also sends read-only `fs/dir/list` with `includeHidden: true` to inventory dotfiles that the tree cannot show (`src/make-client.js:680`).

That socket is Make's `/api/agentcontrol/subscribe`, which drives a per-session sandbox: the same protocol carries process, terminal, language-server and git workload messages. **The bridge reads and writes the sandbox's working copy, not the saved project.** The original four write commands need `--session-only` and report `persistence: "session-only"` (`src/make-session.js:12`, `src/commands/make.js:42`). In older snapshot-mode Make, bridge writes did not update the client tree/editor; git-mode files may receive `fswatch` updates but still need a saved version. Details: [persistence.md](persistence.md). All 112 AtomicAUI files, 51 of them Markdown and up to 5 path segments deep, read and verified this way (2026-10-13).

### Capturing the socket

The page code hooks `WebSocket.prototype.send` passively and records the first socket that identifies itself (`src/make-rpc.js:47`):

- Current Make: `workspace/ensure` carrying a nonempty `data.workspaceId` and `requestId`, on the page's own host over `wss:` at `/api/agentcontrol/subscribe`. It stays pending until `workspace/ensure_ack` arrives on that socket with the matching request ID, `success: true`, and no error. A stale acknowledgement cannot activate a newer capture, and navigation prevents activation (`src/make-rpc.js:38`, `src/make-rpc.js:78`). The ack need not contain a workspace ID; the ID comes from Make's outbound request.
- `control/provision` carrying `data.workspaceId`, on a `wss:` socket on the page's own host (`src/make-rpc.js:37`). Observed live: a background Make page closes `/api/agentcontrol/subscribe` while hidden, and when focus emulation starts it opens a new one and sends `control/provision` about 650 ms later. The CLI arms the hook before enabling focus emulation in every operation (`src/make-client.js:284`).
- Legacy provisioning is not usable until `control/workspace_create_ack` arrives on that socket: earlier `fs/` requests get an uncorrelated `error` frame ("control/workspace_create must be sent before fs/file/read") and never resolve, so the record stays pending until the ack (`src/make-rpc.js:78`). The bridge waits up to 8 s for a pending capture (`src/make-client.js:1209`).
- `fs/file/read` sent by Make itself for a source file. Make caches loaded files, so opening an already-opened file sends nothing; this is why the old capture, which only waited for such a read from the first eight files, failed after earlier editor reads.
- A socket that provisioned while no hook was armed (for example by an earlier command or by a natural tab switch) stays open and sends only `ping`, which carries no workspace. Observed live on AtomicAUI-6.0, 2026-10-13: every capture failed until that socket closed. When nothing is captured, the bridge finds open same-host `/api/agentcontrol/subscribe` sockets with CDP `Runtime.queryObjects` and closes them, unless Make is generating; Make reconnects in about 0.4 s and provisions about 1 s later under the armed hook (`src/make-client.js:1226`, `src/make-client.js:1235`).
- The capture is cached per page under `Symbol.for('figma-cli.make.filesystem.<fileKey>')` until its socket closes (`src/make-rpc.js:21`), so back-to-back commands reuse it.
- When nothing identifies a socket, the command fails with code `MAKE_FILESYSTEM_UNAVAILABLE` and no write (`src/make-client.js:1229`); `read` then falls back to the editor unless `--remote` is set (`src/make-client.js:477`).

Observed live on Lab Management Application with Desktop 126.9.11, 2026-10-24: the existing same-host agent socket idled with `ping`; one deliberate reconnect produced `workspace/ensure` → successful `workspace/ensure_ack` → `fswatch/watch`, without an outbound source-file read. The old capture ignored that handshake even though Make had provisioned its workspace. With the updated capture, read-only `make status` returned `ok: true`, version 1, 24 files, no pending paths and matching saved/working trees; a subsequent `read --remote` of `src/App.tsx` returned the empty starter through the filesystem bridge. No file write, mode change or deploy was performed. This is a protocol detection change, not evidence that a starter file must be edited or regenerated. Offline coverage models the handshake, delayed readiness, request correlation, unsafe endpoints, failed/stale acknowledgements, navigation, and cached-socket reuse (`tests/make-rpc.test.js:93`, `tests/make-client.test.js:673`).

### Replacement

`replace` (`src/make-client.js:945`) refuses a path missing from the tree listing, reads the session's bytes through the bridge and checks `--expected-sha256`, writes a private backup, then calls the page-side `replace` (`src/make-rpc.js:140`). That call re-reads the file, compares it with the backed-up bytes and only then sends the write, all within one page invocation; a mismatch returns `refused` with no write sent. After the write it checks the reply's path and size and reads the file back (`src/make-client.js:1007`); the result is `verification: "session-readback-matched"`, `persistence: "session-only"`. The check is one server round trip before the write, not a server-side compare-and-swap.

An editor already showing the file did not refresh after a bridge write, and bridge-created files did not appear in Make's file tree on the older AtomicAUI-6.0 snapshot file (observed live 2026-10-13). Git-mode behavior differs; use [persistence.md](persistence.md) for the client-VFS path.

Tests: `tests/make-client.test.js` (fixture `FakeSocket` serves session files and models provisioning and workspace creation), `tests/make-rpc.test.js`, `tests/make-session.test.js` (the `--session-only` gate).

Related: [persistence.md](persistence.md), [cdp-page-discovery.md](cdp-page-discovery.md), [files-tab-resolution.md](files-tab-resolution.md).
