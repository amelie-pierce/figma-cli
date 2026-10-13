---
title: Make saving modes and durable git writes
description: How git and snapshot Make files save source, and how figma-cli verifies each path.
date: 2026-10-13
---

# Make persistence and durable git writes

Updated 2026-10-13: git-mode client-VFS writes and version creation are implemented and proven in the scratch Make file. Snapshot mode remains separate.

## Saving modes

Make reports `codeFileChanges.isGitSourceOfTruth` through direct React provider props. The bounded scan rejects absent or conflicting providers instead of traversing unrelated app graphs (`src/make-persistence.js:22`, `src/make-persistence.js:41`). A live read-only check reported AtomicAUI 6.0 as snapshot mode. Hinge reported git mode without a saved baseline; its earlier `unknown` result came from exhausting the old deep-object scan.

The original `replace`, `create`, `import`, and `remove` commands write only the open session's sandbox and require `--session-only` (`src/commands/make.js:41`, `src/make-client.js:728`, `src/make-client.js:828`, `src/make-client.js:862`). A bridge read-back does not save a version. In older snapshot-mode Make, bridge writes did not update the client tree/editor; git-mode Make may receive `fswatch` updates. Neither is persistence proof. See [filesystem-bridge.md](filesystem-bridge.md).

## Durable git-mode path

`make write` and `make delete` refuse snapshot mode or an unverified git baseline (`src/make-durable.js:58`). An existing file needs its prior SHA-256; a new file must omit one. Before a change, the CLI compares the client VFS, editor, tree and session sandbox, and backs up replaced or deleted bytes (`src/make-client.js:448`, `src/make-client.js:482`, `src/make-client.js:518`). A page-side VFS recheck prevents a changed entry from being overwritten (`src/make-durable.js:41`). The result remains pending until a version is saved.

`make save-version` compares the complete pending path set with the caller's expected paths, invokes Make's own in-page `createVersion`, then records the version ID, number and git SHA after Make reports that SHA as its clean baseline (`src/make-client.js:547`, `src/make-durable.js:29`). It refuses unrelated pending changes. An uncertain response must be inspected before retrying.

The 2026-10-13 scratch test saved version 3. After the exact scratch tab reprovisioned into a different sandbox, `make drift` matched four `src` files and both edited paths read back with their saved hashes. A version response or warm read-back alone would not establish that persistence.

## Boundary

The snapshot-mode Save card is not automated. `make drift` reads a complete hidden-file inventory and fails closed when snapshot persistence or a saved git baseline is unverified (`src/make-client.js:576`, `src/make-drift.js:72`). It does not itself prove a fresh sandbox. See [drift.md](drift.md).

Tests: `tests/make-session.test.js`, `tests/make-client.test.js`, `tests/make-drift.test.js`, and `tests/make-durable.test.js`.
