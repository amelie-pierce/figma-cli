---
title: Make saving modes and session-only writes
description: How git and snapshot Make files save source, and what figma-cli can verify.
date: 2026-10-13
---

# Make persistence and session-only writes

Updated 2026-10-13: the earlier blanket Save-card description is narrowed by the AtomicAUI 7.0 git-mode evidence and `make drift`.

## What the CLI writes to

Every Make write command (`replace`, `create`, `import`, `remove`) goes through the [filesystem bridge](filesystem-bridge.md) into the open session's sandbox working copy (`src/make-client.js:604`, `src/make-client.js:761`, `src/make-rpc.js:107`).

- When the Make file is reopened, the working copy is rebuilt from the last saved Make version, and session writes are gone. Observed live on AtomicAUI-6.0, 2026-10-13: 39 files written with `make import` read back with matching SHA-256 in the same session and were missing after a reopen, while the 112 original files were intact.
- The bridge's write reply and the read-back prove only that the sandbox accepted the bytes.
- Make's client code model, file tree and open editor are not notified of bridge writes.

## How Make saves source

Make has two source modes, reported by its read-only `codeFileChanges.isGitSourceOfTruth` state (`src/make-persistence.js:24`). In older snapshot mode, an in-progress manual-edit card offers **Save** and **Discard** and Save uploads the client VFS snapshot. In git mode, Make versions are git commits in its sandbox; the 2026-10-13 AtomicAUI 7.0 investigation observed a saved version and clean pending state after fresh sandbox reprovision. Make's private save flows can change and are not invoked by this CLI.

- figma-cli's existing write commands never trigger a Make save. `make drift` reads git-mode baseline and pending state before and after inventory (`src/make-client.js:435`, `src/make-client.js:478`).
- Whether a snapshot-mode Save captures bridge-only writes is UNVERIFIED. Its snapshot comes from the client code model, which bridge writes do not update.
- Whether Make autosaves on close is UNVERIFIED.
- The endpoint paths, message types and function names behind this flow come from Figma's minified bundles and can change with any Figma update. They are recorded in the 2026-10-13 investigation report of task fig-atomicaui-vendor, kept outside this repository. Treat them as volatile and re-derive them before relying on one; never call them by hand.

## What the CLI does about it

- The four write commands refuse before connecting unless `--session-only` is passed (`src/commands/make.js:42`, `src/make-session.js:15`). The refusal code is `MAKE_SESSION_ONLY_REQUIRED`. The flag only accepts the limitation; the expected SHA-256 check, backup and read-back still run.
- Completed writes report `persistence: "session-only"` and a `note` (`src/make-session.js:12`), with `verification: "session-readback-matched"` (`replace`, `create`, `import`) or `"session-delete-accepted"` (`remove`). The earlier `server-acknowledged` and `acknowledged` labels claimed a save that never happened.
- An import error lists files written in the session as `sessionWrites` (`src/commands/make.js:21`).
- Reads (`read`, `files`, `verify`) read the same working copy (`src/make-client.js:374`, `src/make-client.js:385`, `src/make-client.js:652`). `make drift` additionally requires a clean saved git baseline and complete byte inventory, or it exits nonzero (`src/make-drift.js:72`). It is not a fresh-sandbox reprovision check.

## History

The earlier adapter's editor-path `replace` dispatched into CodeMirror but did not save a Make version. Current write commands still only return session evidence (`src/make-client.js:636`, `src/make-client.js:789`).

## Not implemented

A CLI write path that creates and verifies a saved Make version. Git and snapshot modes need separate handling and scratch-file proof. `make drift` is read-only and fails closed for snapshot-mode persistence (`src/make-drift.js:81`). See [drift.md](drift.md).

Tests: `tests/make-session.test.js` (gate and label), `tests/make-client.test.js` (session-only labels), `tests/make-drift.test.js` (saving modes and drift classifications).

Related: [filesystem-bridge.md](filesystem-bridge.md).
