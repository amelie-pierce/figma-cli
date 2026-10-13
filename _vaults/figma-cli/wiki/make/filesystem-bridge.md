---
title: Make file selection limits and the filesystem bridge
description: Why editor-based Make commands refuse deep files, and how read/replace/import/verify/remove reach any file in the open session's sandbox working copy through Make's own filesystem socket.
date: 2026-10-13
---

Updated 2026-10-13: the bridge reaches the session's sandbox working copy, not saved project storage; see [persistence.md](persistence.md).

# Make file selection limits and the filesystem bridge

Make source commands reach a file in one of two ways.

## Editor path: limited by the file-tree viewport

`diagnostics`, and `read` only as a fallback, select the file's row in the virtualized file tree and read the CodeMirror document.

- The tree is DOM-only, so an unmounted ancestor row cannot be proven. Selection therefore requires every ancestor folder and the file to be rendered together, and refuses otherwise (`src/make-tree.js:331`, `src/make-tree.js:206`). On the AtomicAUI-6.0 project this refused 38 of 112 files at a 1800x1092 window (for example `src/components/Fieldset.tsx`).
- Markdown opens as a rendered preview with no CodeMirror editor, so an editor read waits for an editor that never appears and times out (`src/make-client.js:289`; observed live on `guidelines/Guidelines.md`, 2026-10-13).

## Filesystem bridge: any depth, any text file

`read`, `replace`, `create`/`import`, `verify` and `remove` send Make's own `fs/file/read|write|delete` messages on the page's existing authenticated WebSocket (`src/make-rpc.js:112`, `src/make-client.js:416`, `src/make-client.js:604`). No tree selection is involved, so depth and file type do not matter. `make drift` also sends read-only `fs/dir/list` with `includeHidden: true` to inventory dotfiles that the tree cannot show (`src/make-client.js:451`).

That socket is Make's `/api/agentcontrol/subscribe`, which drives a per-session sandbox: the same protocol carries process, terminal, language-server and git workload messages. **The bridge reads and writes the sandbox's working copy, not the saved project.** Writes are lost when the file is reopened unless saved in Make, and Make's client file tree and open editor are not notified of them. Every write command therefore needs `--session-only` and reports `persistence: "session-only"` (`src/make-session.js:12`, `src/commands/make.js:42`). Details and evidence: [persistence.md](persistence.md). All 112 AtomicAUI files, 51 of them Markdown and up to 5 path segments deep, read and verified this way (2026-10-13).

### Capturing the socket

The page code hooks `WebSocket.prototype.send` passively and records the first socket that identifies itself (`src/make-rpc.js:41`):

- `control/provision` carrying `data.workspaceId`, on a `wss:` socket on the page's own host (`src/make-rpc.js:35`). Observed live: a background Make page closes `/api/agentcontrol/subscribe` while hidden, and when focus emulation starts it opens a new one and sends `control/provision` about 650 ms later. The CLI arms the hook before enabling focus emulation in every operation (`src/make-client.js:231`).
- The provisioned socket is not usable until `control/workspace_create_ack` arrives on it: earlier `fs/` requests get an uncorrelated `error` frame ("control/workspace_create must be sent before fs/file/read") and never resolve, so the record stays pending until the ack (`src/make-rpc.js:75`). The bridge waits up to 8 s for a pending capture (`src/make-client.js:456`).
- `fs/file/read` sent by Make itself for a source file. Make caches loaded files, so opening an already-opened file sends nothing; this is why the old capture, which only waited for such a read from the first eight files, failed after earlier editor reads.
- A socket that provisioned while no hook was armed (for example by an earlier command or by a natural tab switch) stays open and sends only `ping`, which carries no workspace. Observed live on AtomicAUI-6.0, 2026-10-13: every capture failed until that socket closed. When nothing is captured, the bridge finds open same-host `/api/agentcontrol/subscribe` sockets with CDP `Runtime.queryObjects` and closes them, unless Make is generating; Make reconnects in about 0.4 s and provisions about 1 s later under the armed hook (`src/make-client.js:471`).
- The capture is cached per page under `Symbol.for('figma-cli.make.filesystem.<fileKey>')` until its socket closes (`src/make-rpc.js:19`), so back-to-back commands reuse it.
- When nothing identifies a socket, the command fails with code `MAKE_FILESYSTEM_UNAVAILABLE` and no write (`src/make-client.js:467`); `read` then falls back to the editor unless `--remote` is set (`src/make-client.js:396`).

### Replacement

`replace` (`src/make-client.js:651`) refuses a path missing from the tree listing, reads the session's bytes through the bridge and checks `--expected-sha256`, writes a private backup, then calls the page-side `replace` (`src/make-rpc.js:140`). That call re-reads the file, compares it with the backed-up bytes and only then sends the write, all within one page invocation; a mismatch returns `refused` with no write sent. After the write it checks the reply's path and size and reads the file back (`src/make-client.js:713`); the result is `verification: "session-readback-matched"`, `persistence: "session-only"`. The check is one server round trip before the write, not a server-side compare-and-swap.

An editor already showing the file does not refresh after a bridge write, and bridge-created files do not appear in Make's file tree (observed live on AtomicAUI-6.0, 2026-10-13): Make's client code model is never told about the write.

Tests: `tests/make-client.test.js` (fixture `FakeSocket` serves session files and models provisioning and workspace creation), `tests/make-rpc.test.js`, `tests/make-session.test.js` (the `--session-only` gate).

Related: [persistence.md](persistence.md), [cdp-page-discovery.md](cdp-page-discovery.md), [files-tab-resolution.md](files-tab-resolution.md).
