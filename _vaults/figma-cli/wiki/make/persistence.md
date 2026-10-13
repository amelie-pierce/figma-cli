---
title: Make persistence and session-only writes
description: Why every figma-cli Make write is session-only, how Make itself saves source, and what reads and verify can and cannot prove.
date: 2026-10-13
---

# Make persistence and session-only writes

## What the CLI writes to

Every Make write command (`replace`, `create`, `import`, `remove`) goes through the [filesystem bridge](filesystem-bridge.md) into the open session's sandbox working copy (`src/make-client.js:557`, `src/make-client.js:636`, `src/make-rpc.js:151`).

- When the Make file is reopened, the working copy is rebuilt from the last saved Make version, and session writes are gone. Observed live on AtomicAUI-6.0, 2026-10-13: 39 files written with `make import` read back with matching SHA-256 in the same session and were missing after a reopen, while the 112 original files were intact.
- The bridge's write reply and the read-back prove only that the sandbox accepted the bytes.
- Make's client code model, file tree and open editor are not notified of bridge writes.

## How Make saves source

Make saves source only through its own manual-edit commit. Its chat panel shows an in-progress manual-edit card listing the edited files, with **Save** and **Discard**. Save uploads a code snapshot (or, when git is the source of truth, creates a version in the sandbox), commits a chat message, and creates a new Make version. Make also saves pending manual edits before a version restore.

- figma-cli never triggers that Save and never checks for it.
- Whether a Save captures bridge-only writes is UNVERIFIED. In non-git mode the snapshot comes from the client code model, which bridge writes never reach, so it likely would not.
- Whether Make autosaves on close is UNVERIFIED.
- The endpoint paths, message types and function names behind this flow come from Figma's minified bundles and can change with any Figma update. They are recorded in the 2026-10-13 investigation report of task fig-atomicaui-vendor, kept outside this repository. Treat them as volatile and re-derive them before relying on one; never call them by hand.

## What the CLI does about it

- The four write commands refuse before connecting unless `--session-only` is passed (`src/commands/make.js:42`, `src/make-session.js:15`). The refusal code is `MAKE_SESSION_ONLY_REQUIRED`. The flag only accepts the limitation; the expected SHA-256 check, backup and read-back still run.
- Completed writes report `persistence: "session-only"` and a `note` (`src/make-session.js:12`), with `verification: "session-readback-matched"` (`replace`, `create`, `import`) or `"session-delete-accepted"` (`remove`). The earlier `server-acknowledged` and `acknowledged` labels claimed a save that never happened.
- An import error lists files written in the session as `sessionWrites` (`src/commands/make.js:21`).
- Reads (`read`, `files`, `verify`) read the same working copy. They equal the saved project only when no session write or manual edit is pending, so a match proves session state, not persistence.

## History

`import` and `create` used the bridge from the first Make commit. Before the bridge `replace`, the editor-path `replace` dispatched into CodeMirror and observed Make's mirrored sandbox write, but it also never ran Save. No version of the CLI has shown a write surviving a reopen.

## Not implemented

A persisting write path: write through Make's editor (so the client code model and the manual-edit card see the change), then run Make's Save, confirm a new version, and verify against the saved version rather than the sandbox. It needs a proof in a scratch Make file first.

Tests: `tests/make-session.test.js` (gate and label), `tests/make-client.test.js` (session-only labels on `replace` and `remove`).

Related: [filesystem-bridge.md](filesystem-bridge.md).
