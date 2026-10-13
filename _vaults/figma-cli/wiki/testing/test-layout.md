---
title: Test layout
description: Where tests live, how to run them, and the fixtures used for Make code.
date: 2026-10-13
---

# Test layout

- `npm test` runs every `tests/*.test.js` with `node --test` (`package.json:41`). `npm run test:make` runs the Make and CDP subset plus a few named suites (`tests/run-make-tests.mjs:6`).
- Live checks against a real Figma file are separate scripts under `tests/live/` and are not part of `npm test` (`package.json:42`).
- `tests/make-client.test.js:16` (`fixture`) runs the real serialized page functions (`makeWorkspace`, `makeEditorAction`, tree code) in a `vm` context against a small fake DOM, so selector and guard logic is exercised without Figma. Options such as `workspace`, `filesTabs`, `tabTitles`, `code` and `key` shape the DOM; `state` records clicks (`tabClicks`, `clickedTabs`, `addClicks`, `filesClicks`, `closeClicks`) and `dispatches`.
- `tests/make-client.test.js:165` (`setup`) connects a `MakeClient` to that fixture with key `ExactKey`; setting `state.key` afterwards simulates the page navigating to another project.
- `tests/make-transport.test.js:8` (`fakeCDP`) serves a fake `/json` target list and WebSocket for transport discovery tests.
- Hazard: `npm test` includes `tests/instantiate-roundtrip.test.js`, gated only on a live `eval` returning `ok` (`tests/instantiate-roundtrip.test.js:22`). When Figma Desktop is reachable on the configured port, it starts the figma-cli daemon and builds, then removes, a fixture page in whichever Design file the daemon is bound to (`tests/instantiate-roundtrip.test.js:30`). When the daemon is bound to a Make page there is no `figma` global and the build fails with a TypeError, which shows up as a test failure, not a write. To validate Make changes without touching a live file, run `npm run test:make` or `node --test` on the specific files.
