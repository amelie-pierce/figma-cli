---
title: Make saving modes and durable git writes
description: How git and snapshot Make files save source, and how figma-cli verifies each path.
date: 2026-10-14
---

# Make persistence and durable git writes

Updated 2026-10-13: git-mode client-VFS writes and version creation are implemented and proven in the scratch Make file. Snapshot mode remains separate.
Updated 2026-10-14: preview-only files (Markdown) and Make's unlisted root files; see the two sections below.

## Saving modes

Make reports `codeFileChanges.isGitSourceOfTruth` through direct React provider props. The bounded scan rejects absent or conflicting providers instead of traversing unrelated app graphs (`src/make-persistence.js:21`, `src/make-persistence.js:51`). A live read-only check reported AtomicAUI 6.0 as snapshot mode. Hinge reported git mode without a saved baseline; its earlier `unknown` result came from exhausting the old deep-object scan.

The original `replace`, `create`, `import`, and `remove` commands write only the open session's sandbox and require `--session-only` (`src/commands/make.js:41`, `src/make-client.js:731`, `src/make-client.js:831`, `src/make-client.js:865`). A bridge read-back does not save a version. In older snapshot-mode Make, bridge writes did not update the client tree/editor; git-mode Make may receive `fswatch` updates. Neither is persistence proof. See [filesystem-bridge.md](filesystem-bridge.md).

## Durable git-mode path

`make write` and `make delete` refuse snapshot mode or an unverified git baseline (`src/make-durable.js:75`). An existing file needs its prior SHA-256; a new file must omit one. Before a change, the CLI compares the client VFS, editor, tree and session sandbox, and backs up replaced or deleted bytes (`src/make-client.js:479`, `src/make-client.js:540`, `src/make-client.js:578`). A page-side VFS recheck prevents a changed entry from being overwritten (`src/make-durable.js:58`). The result remains pending until a version is saved.

`make save-version` compares the complete pending path set with the caller's expected paths, invokes Make's own in-page `createVersion`, then records the version ID, number and git SHA after Make reports that SHA as its clean baseline (`src/make-client.js:627`, `src/make-durable.js:39`). It refuses unrelated pending changes and an empty expected set. If the clean baseline is not observed after createVersion, the error still carries the version ID, number and SHA. An uncertain response must be inspected before retrying.

The 2026-10-13 scratch test saved version 3. After the exact scratch tab reprovisioned into a different sandbox, `make drift` matched four `src` files and both edited paths read back with their saved hashes. A version response or warm read-back alone would not establish that persistence.

## Files without an editor

Make shows Markdown as a preview, with no source editor (`editorCount` stays 0). The read-back used to wait for an editor read that never came, so `make write` on a `.md` path stalled until its timeout. `_read` now takes `editorWaitMs` and throws `MAKE_NO_EDITOR` when no editor appears in that window (`src/make-client.js:300`, window `EDITOR_WAIT_MS` at `src/make-client.js:20`). `_durableAgreement` then accepts client VFS, sandbox and rendered-tree agreement as the proof, `tree-vfs-sandbox-matched`; a file with an editor still needs the editor to match (`src/make-client.js:479`). At the deadline the error names the last state of each view instead of a bare timeout.

New-file absence is proven by listing the nearest existing ancestor through the bridge, and the bridge guard refuses `code` itself (`src/make-rpc.js:113`). A new file directly under the root or in a new top-level folder is therefore refused before any change (`src/make-client.js:469`). Hidden top-level folders are not in the rendered tree and are still attempted.

## Root files Make does not list as pending

Make's client hides some paths from its file lists and `codeFileChanges.changedFiles`: root dot-paths, root `package-lock.json` and `pnpm-lock.yaml`, and root `CLAUDE.md` and `AGENTS.md` unless a `showAgentInstructionFiles` option is set. Evidence: a hidden-file predicate in Make's public client bundle (minified, read 2026-10-14); that `changedFiles` is built through this exact predicate is `UNVERIFIED`. Make's rendered tree still showed root `AGENTS.md` and `CLAUDE.md` in the scratch file.

`createVersion` still commits these files. `UNLISTED_PERSISTED_PATHS` allowlists only the two proven paths, `AGENTS.md` and `CLAUDE.md` (`src/make-durable.js:88`). `requireExactPending` lets an expected allowlisted path be absent from pending, and still refuses any unexpected pending path or missing ordinary path (`src/make-durable.js:93`). `saveVersion` captures each unlisted path from both the client VFS and sandbox before the save and reads it back after the clean baseline (`src/make-client.js:610`, `src/make-client.js:627`). The result lists the paths under `unlistedFiles` with `verification: saved-version-clean-pending; unlisted-post-save-read-matched`. A mismatch after the save carries the version and says not to retry. Lockfiles and root dotfiles are not allowlisted, because their persistence has not been proven.

Live proof, scratch file `EtRNzbPHj8k07PiTgqnY7N`, 2026-10-14:
- New `src/probe.md` (sha256 `4e1e23b3…7f51`) wrote with `tree-vfs-sandbox-matched` in about 5 s. Root `AGENTS.md` (`b39f6ead…6b77` → `e62b7583…c0e`) and `CLAUDE.md` (`336cc4fb…ab49` → `ee6e887b…e09a`) wrote the same way. Pending listed only `src/probe.md`.
- Version 15 (`0119c5d1…def9`) saved with `changedFiles` = 1 path and `unlistedFiles` = 2 paths. After a `Page.reload` of only that tab, all three hashes read back and pending was 0 at `0119c5d1…`.
- Version 16 (`7a16a3c6…48fa`) saved with 0 listed paths and only `AGENTS.md` expected, restoring `b39f6ead…6b77`. That hash read back after another reload.
- `docs/probe.md` (new top-level folder) was refused before writing.

## Boundary

The snapshot-mode Save card is not automated. `make drift` reads a complete hidden-file inventory and fails closed when snapshot persistence or a saved git baseline is unverified (`src/make-client.js:670`, `src/make-drift.js:72`). It does not itself prove a fresh sandbox. See [drift.md](drift.md).

Tests: `tests/make-session.test.js`, `tests/make-client.test.js`, `tests/make-drift.test.js`, and `tests/make-durable.test.js`.
