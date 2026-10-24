---
title: Make saving modes and durable git writes
description: How git and snapshot Make files save source, how figma-cli verifies each path, and how it creates a first version.
date: 2026-10-14
---

# Make persistence and durable git writes

Updated 2026-10-13: git-mode client-VFS writes and version creation are implemented and proven in the scratch Make file. Snapshot mode remains separate.
Updated 2026-10-14: preview-only files (Markdown) and Make's unlisted root files; see the two sections below.
Updated 2026-10-14: first version of a never-saved git-mode file (`--first-version`); see "First version" below.
Updated 2026-10-16: durable read-back for unopened source files and deep tree paths.
Updated 2026-10-24: current async client-VFS lookup and text-entry validation; see [durable-vfs-api.md](durable-vfs-api.md).

## Saving modes

Make reports `codeFileChanges.isGitSourceOfTruth` through direct React provider props. The bounded scan rejects absent or conflicting providers instead of traversing unrelated app graphs (`src/make-persistence.js:21`, `src/make-persistence.js:51`). A live read-only check reported AtomicAUI 6.0 as snapshot mode. Hinge reported git mode without a saved baseline; its earlier `unknown` result came from exhausting the old deep-object scan.

The original `replace`, `create`, `import`, and `remove` commands write only the open session's sandbox and require `--session-only` (`src/commands/make.js:41`, `src/make-client.js:845`, `src/make-client.js:945`, `src/make-client.js:979`). A bridge read-back does not save a version. In older snapshot-mode Make, bridge writes did not update the client tree/editor; git-mode Make may receive `fswatch` updates. Neither is persistence proof. See [filesystem-bridge.md](filesystem-bridge.md).

## Durable git-mode path

`make write` and `make delete` refuse snapshot mode or an unverified git baseline (`src/make-durable.js:83`). An existing file needs its prior SHA-256; a new file must omit one. Before a change, the CLI compares the client VFS, editor, tree and session sandbox, and backs up replaced or deleted bytes (`src/make-client.js:479`, `src/make-client.js:542`, `src/make-client.js:580`). A page-side VFS recheck prevents a changed entry from being overwritten (`src/make-durable.js:64`). The result remains pending until a version is saved.

`make save-version` compares the complete pending path set with the caller's expected paths, invokes Make's own in-page `createVersion`, then records the version ID, number and git SHA after Make reports that SHA as its clean baseline (`src/make-client.js:629`, `src/make-durable.js:41`). It refuses unrelated pending changes and an empty expected set. If the clean baseline is not observed after createVersion, the error still carries the version ID, number and SHA. An uncertain response must be inspected before retrying.

The 2026-10-13 scratch test saved version 3. After the exact scratch tab reprovisioned into a different sandbox, `make drift` matched four `src` files and both edited paths read back with their saved hashes. A version response or warm read-back alone would not establish that persistence.

## Files without an editor

Make shows Markdown as a preview, with no source editor; it may also leave an unopened source file without one. `_read` uses a bounded editor wait and reports `MAKE_NO_EDITOR` if none mounts (`src/make-client.js:345`). `_durableAgreement` then accepts matching client VFS and sandbox bytes plus a rendered tree entry for any such file (`src/make-client.js:540`). A deep path whose ancestry cannot fit in the tree viewport is refused with `MAKE_TREE_VIEWPORT` (`src/make-tree.js:333`). It takes the same fallback only when no editor is mounted or the Files workspace breadcrumb names another full path (`editorPath`, `src/make-client.js:71`, `src/make-client.js:593`); an editor of unknown path, as in the legacy layout, or of the target path is not accepted. A mounted editor with different bytes, a missing tree entry, or a VFS or sandbox mismatch still fails (`src/make-client.js:568`, `src/make-client.js:590`). The same shared check is called before and after durable writes, including deploy writes (`src/make-client.js:633`, `src/make-client.js:646`). At the deadline the error names the last state of each view instead of a bare timeout (`src/make-client.js:608`).

New-file absence is proven by listing the nearest existing ancestor through the bridge. The bridge lets `code` itself only be listed, for [status.md](status.md) (`src/make-rpc.js:113`), and the write path never lists it. A new file directly under the root or in a new top-level folder is therefore refused before any change (`src/make-client.js:534`). A caller may name `baseFolders` it knows are in the saved base; a create there may proceed when the folder has left the tree and `fetchEntry` finds no file at the path (deploy only; see [deploy.md](deploy.md#emptied-top-level-folders), Updated 2026-10-24). Hidden top-level folders are not in the rendered tree and are still attempted. Make's client VFS itself showed no root restriction in read-only inspection; see [deploy.md](deploy.md#root-files-and-new-top-level-folders) (Updated 2026-10-24).

## Root files Make does not list as pending

Make's client hides some paths from its file lists and `codeFileChanges.changedFiles`: root dot-paths, root `package-lock.json` and `pnpm-lock.yaml`, and root `CLAUDE.md` and `AGENTS.md` unless a `showAgentInstructionFiles` option is set. Evidence: a hidden-file predicate in Make's public client bundle (minified, read 2026-10-14); that `changedFiles` is built through this exact predicate is `UNVERIFIED`. Make's rendered tree still showed root `AGENTS.md` and `CLAUDE.md` in the scratch file.

`createVersion` still commits these files. `UNLISTED_PERSISTED_PATHS` allowlists only the two proven paths, `AGENTS.md` and `CLAUDE.md` (`src/make-durable.js:120`). `requireExactPending` lets an expected allowlisted path be absent from pending, and still refuses any unexpected pending path or missing ordinary path (`src/make-durable.js:125`). `saveVersion` captures each unlisted path from both the client VFS and sandbox before the save and reads it back after the clean baseline (`src/make-client.js:612`, `src/make-client.js:629`). The result lists the paths under `unlistedFiles` with `verification: saved-version-clean-pending; unlisted-post-save-read-matched`. A mismatch after the save carries the version and says not to retry. Lockfiles and root dotfiles are not allowlisted, because their persistence has not been proven. Updated 2026-10-15: root `pnpm-lock.yaml` and `package-lock.json` are also absent from the rendered tree, so their write read-back uses client VFS and sandbox agreement (`TREE_HIDDEN_ROOT_FILES`, `src/make-durable.js`). A deploy saved a lockfile through the tree-checked save and it read back after a reload; see [deploy.md](deploy.md).

Live proof, scratch file `EtRNzbPHj8k07PiTgqnY7N`, 2026-10-14:
- New `src/probe.md` (sha256 `4e1e23b3…7f51`) wrote with `tree-vfs-sandbox-matched` in about 5 s. Root `AGENTS.md` (`b39f6ead…6b77` → `e62b7583…c0e`) and `CLAUDE.md` (`336cc4fb…ab49` → `ee6e887b…e09a`) wrote the same way. Pending listed only `src/probe.md`.
- Version 15 (`0119c5d1…def9`) saved with `changedFiles` = 1 path and `unlistedFiles` = 2 paths. After a `Page.reload` of only that tab, all three hashes read back and pending was 0 at `0119c5d1…`.
- Version 16 (`7a16a3c6…48fa`) saved with 0 listed paths and only `AGENTS.md` expected, restoring `b39f6ead…6b77`. That hash read back after another reload.
- `docs/probe.md` (new top-level folder) was refused before writing.

## First version

A git-mode file that was never saved has `hasBaseline: false`. Make computes `hasBaseline` and `changedFiles` from the git SHA of the newest server-side Make version (a `fileMakeVersions` query, first page of 1). With no version it sets `changedFiles` to `[]`, so Make lists no pending files at all. Its manual-edit Save card appears only when `hasBaseline` is true. Make's AI-turn commit calls `createMakeVersion` with no baseline check, which is how a file normally gets its first version. Evidence: Make's public client bundle (minified, read 2026-10-14).

The sandbox commits every write to its git `main` ("fs write: …") and `origin/main` follows, so the sandbox HEAD is no base either. `requireGitMode(state, { firstVersion: true })` accepts only a clean no-baseline git state and refuses a baselined one (`src/make-durable.js:83`). `make write` and `make delete` take the same flag. `saveFirstVersion` requires `--since`, a sandbox commit the caller read from `make status` before writing. It checks that commit is in HEAD's history (`src/sandbox-git.js:172`, `src/make-client.js:693`). It requires the expected paths to equal exactly the difference between that commit's tree and the working copy (`src/make-durable.js:107`). It rechecks Make's state and HEAD, then calls `createVersion` through the page action's `firstVersion` branch (`src/make-durable.js:46`). Afterwards it waits for the clean baseline and checks that the saved tree equals the working tree it checked (`src/make-client.js:681`). The AGENTS.md/CLAUDE.md allowance does not apply, because the project inventory lists those files.

Live proof, scratch file `mhuFL1utXbtUonfO5uKA8e`, 2026-10-14:
- Before: git, no baseline, 0 pending, sandbox HEAD `af344d81…` (bootstrap → template "fs write"), tree `f937e7e1…`, 24 files.
- `make write src/first-version-probe.ts --first-version` (sha256 `3ba3ae47…1e20e`) matched in the editor, tree, VFS and sandbox. Make still listed 0 pending; HEAD moved to `fa94633b…`, tree `f4bf6828…`.
- A wrong expected set and a foreign `--since` were refused before `createVersion`.
- Version 1 (`fa94633b…`, the sandbox HEAD itself) saved with 1 changed path; its tree `f4bf6828…` equalled the checked working tree. After a `Page.reload` of only that tab, the sandbox provider changed, `hasBaseline` was true at `fa94633b…`, 0 were pending, the saved tree equalled the working tree, and the probe hash read back.
- With a baseline, `--first-version` was refused on both `write` and `save-version`. An ordinary write (sha256 `1ffc2c06…2127`) and `save-version` made version 2 (`ce12e79a…`), which read back after another reload.

Hinge (`ydPjoL41RjmufNbv93gPnq`), read-only on 2026-10-14: git mode, no baseline, 0 pending, one chat thread. Its sandbox stayed `REPROVISIONING` in a background tab, so its file list could not be read. Its GitHub mirror holds 24 files from its last Push.

## Boundary

The snapshot-mode Save card is not automated. `make drift` reads a complete hidden-file inventory and fails closed when snapshot persistence or a saved git baseline is unverified (`src/make-client.js:743`, `src/make-drift.js:72`). It does not itself prove a fresh sandbox. See [drift.md](drift.md).

Tests: `tests/make-session.test.js`, `tests/make-client.test.js`, `tests/make-drift.test.js`, and `tests/make-durable.test.js`.
