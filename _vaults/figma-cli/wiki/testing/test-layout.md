---
title: Test layout
description: Where tests live, how to run them, and the fixtures used for Make code.
date: 2026-10-13
---

# Test layout

- `npm test` runs every `tests/*.test.js` with `node --test` (`package.json:41`). `npm run test:make` runs the Make and CDP subset plus a few named suites (`tests/run-make-tests.mjs:6`).
- Live checks against a real Figma file are separate scripts under `tests/live/` and are not part of `npm test` (`package.json:42`).
- `tests/make-client.test.js:17` (`fixture`) runs the real serialized page functions (`makeWorkspace`, `makeEditorAction`, tree code, `captureMakeFileSocket`) in a `vm` context against a small fake DOM, so selector and guard logic is exercised without Figma. Options such as `workspace`, `filesTabs`, `tabTitles`, `code` and `key` shape the DOM; `state` records clicks (`tabClicks`, `clickedTabs`, `addClicks`, `filesClicks`, `closeClicks`) and `dispatches`.
- The same fixture models Make's filesystem socket (Updated 2026-10-13): `FakeSocket` serves saved files from `state.fs` and records `frames` and `fsWrites`; enabling focus emulation provisions a new socket and creates its workspace after `workspaceDelay` unless `provisionOnFocus` is false, and closing it reconnects unless `reconnectOnClose` is false; `fetchOnSelect` makes a tree click send Make's own `fs/file/read`; `writeMode` (`lost`, `rejected`, `corrupt`) and `beforeFsRead`/`beforeFsWrite` inject failures; `extraFolders` with a small `clientHeight` builds a file too deep for the editor path. Its fake CDP `send` honours `timeoutMs` like the real transport, and page timers longer than 100 ms are real but unref'd. See [../make/filesystem-bridge.md](../make/filesystem-bridge.md).
- The fixture also answers `fs/file/delete`, recording `state.fsDeletes` (Updated 2026-10-13).
- `tests/make-session.test.js` spawns the real CLI with `--port 1`, a closed port, so a write without `--session-only` must fail with `MAKE_SESSION_ONLY_REQUIRED` and any connection attempt fails with `CDP_DISCOVERY_FAILED`; it never reaches Figma. See [../make/persistence.md](../make/persistence.md).
- `tests/make-client.test.js:283` (`setup`) connects a `MakeClient` to that fixture with key `ExactKey`; setting `state.key` afterwards simulates the page navigating to another project.
- `tests/make-transport.test.js:8` (`fakeCDP`) serves a fake `/json` target list and WebSocket for transport discovery tests.
- Hazard: `npm test` includes `tests/instantiate-roundtrip.test.js`, gated only on a live `eval` returning `ok` (`tests/instantiate-roundtrip.test.js:22`). When Figma Desktop is reachable on the configured port, it starts the figma-cli daemon and builds, then removes, a fixture page in whichever Design file the daemon is bound to (`tests/instantiate-roundtrip.test.js:30`). When the daemon is bound to a Make page there is no `figma` global and the build fails with a TypeError, which shows up as a test failure, not a write. To validate Make changes without touching a live file, run `npm run test:make` or `node --test` on the specific files.
