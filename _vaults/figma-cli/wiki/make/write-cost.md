---
title: What a durable Make write costs, and the batched write
description: Where the seconds per file go in a durable write, the measured fixed costs of Make, and how writeDurableBatch pays them once per batch.
date: 2026-11-25
---

# What a durable Make write costs, and the batched write

A durable write to Make (`writeDurable`, `deleteDurable`, `src/make-client.js`) takes 5-9 s per file on a small tree and far more on a big one. The cost is fixed per request, not per byte: a 0.3 KB file and a 422 KB file take about the same. Measured on the scratch file "Initialize Blank Page" (Figma Desktop 126.9, 37 files, 11 folders; scratch evidence only, no team file).

## Cost model (one durable write, before the 2026-11-25 changes)

| Step | Measured | Where |
|---|---|---|
| Tree scan (`_sourceTree`), 2-3 per write | 0.1 s on a tiny tree; 2.7-2.8 s at 11 folders | `src/make-client.js` `_sourceTree`, `src/make-tree.js` `scanTree` |
| Select a file in the editor (agreement's editor view) | 1.0-1.1 s, and it collapsed every unrelated folder so the next scan re-expanded them (about 0.25 s per folder) | removed from writes and deletes (an editor already showing the file is still compared, never selected) |
| Sandbox filesystem request | about 0.33 s each, but concurrent requests overlap (6 sequential 2.0 s, 6 concurrent 0.33 s) | [filesystem-bridge.md](filesystem-bridge.md), `READ_CONCURRENCY` in `src/lib/map-limit.js` |
| `vfs.writeFile` | 0.35 s alone, about 0.66 s each when many are queued; Make serialises them, four concurrent writers gained nothing (7.4 s vs 7.9 s for 12) | page action in `src/make-durable.js` |
| Tracker lag (`codeFileChanges` lists a path late) | about 0.74 s, plus one 0.33 s re-verify | `_settleTracker`, [tracker-latency.md](tracker-latency.md) |
| Saved-tree flatten (first mutation per client) | 3.6-4.3 s once per `MakeClient` | `_pendingAfterMutation` |
| Absence check of a file in a new folder | 5 s per unanswered missing-folder listing | `_sandboxAbsent`; [size-and-timeouts.md](size-and-timeouts.md) |

So "5-10 s per file" is a folder-count and tree-shape cost, not a file-size cost. The three fixes before this one: no editor `select` during write and delete checks (edit 9.3 s to 1.7 s), a new-folder absence check that starts at the nearest ancestor the tree already shows, and overlapping independent sandbox reads (R4, `mapLimit`).

## The batched write (Updated 2026-11-25)

`MakeClient.writeDurableBatch(items, { baseFolders, backupDir })` (`src/make-client.js:1300`; items validated by `batchPlan`, `src/make-client.js:33`) writes up to 25 files and 8 MiB of content (`src/make-batch.js:5`, `src/make-batch.js:6`) in one operation: ordered `{ path, content }` writes and `{ path, delete: true }` deletes, each with its own `expectedSha256`. Per batch it pays the fixed costs once:

1. Every file's sha256 precondition against the client VFS (a changed file refuses the whole batch before anything is written).
2. One tree scan before (`_agreeBatch(..., 'before')`, `src/make-client.js:1212`): the ancestor proof for each new or deleted file (`_requireTreeAncestor`, `src/make-client.js:821`, shared with `_requireListableAncestor`, `src/make-client.js:811`), the sandbox pre-read of every existing file and the absence check of every new one overlapping through `mapLimit` (`_batchReads`, `src/make-client.js:1176`), VFS and sandbox must equal.
3. One tracker expectation for the union of the files (`_pendingAfterMutation` per file), every file's backup, an immediate drift re-check.
4. The writes one at a time in the given order, each guarded in the page by `expectedContent`.
5. One read-back (`_agreeBatch(..., 'after')`): per file the client VFS and the sandbox must equal the target (or both lack a deleted file), the editor buffer must match when it already shows one of the files, then one tree scan checked by `checkChangedTree` (`src/make-tree.js:359`, called from `scanAfterChange`, `src/make-tree.js:418`).
6. One `_settleTracker` (`src/make-client.js:671`) for the union, and, only if it had to wait, a re-read of both views of every file.

Scout prototype on the scratch file, one process: 12 edits 13.4 s, 12 new 14.3 s, 36 deletes 31.3 s, so 0.8-1.2 s per file against 5-9 s, with the floor set by Make's own `vfs.writeFile` (0.66 s each). The production build's timings against the per-file path are in the pull request that introduced it.

### What is kept, exactly

- Per-file sha256 precondition before its write and per-file byte-equality of client VFS and sandbox after it; the results carry the same `verification` strings as `writeDurable`.
- The tree after a batch must differ from the tree before it by exactly the written paths (with new ancestor folders) and removed paths (with folders they empty): `checkChangedTree` takes `writtenPaths` / `removedPaths` and still compares every other entry, edited files included, by kind, level and row height (`tests/make-batch.test.js`). One-file callers pass `writtenPath` / `removedPath` as before.
- Dependency files (`package.json`, `pnpm-lock.yaml`, `package-lock.json`) and every `VENDOR.json` are refused by the client (`batchBarred`, `src/make-batch.js:13`): they stay single operations with their own settle, and VENDOR.json stays the separate last write after its files are confirmed.
- The pre-write agreement includes the editor view a single write runs: a mounted editor whose buffer differs from the client VFS refuses the batch before any write (`_agreeBatch` 'before' compares the editor against each file's original, never selecting it).
- After the first write any failure carries `error.batchWritesStarted`, `error.completedWrites` (read back equal) and `error.uncertainWrites` (may have landed). A failure of the write loop or of the read-back after it, other than a page refusal, also carries `error.batchTracker` for the follow-up read below (as `writeDurable` sets `trackerExpectation` only when the page did not refuse) and, when that read-back timed out, `error.observed` (the last view of each file). With time left the failed operation reads its own writes back, so a tree-changed failure after the writes carries every file in `completedWrites` and none uncertain. `writeDurableBatch` also attaches the first three to a rejection `_operation` raises after a successful batch (focus-emulation cleanup failure, `src/make-client.js` `_operation`): the written files as `completedWrites`, or every changed file as `uncertainWrites` if it has no results. A page refusal stops the batch with a confirmed prefix. On a deadline timeout nothing can be read back inside the failed operation (no bridge opens past the deadline), so every accepted file is uncertain and `completedWrites` is empty. Nothing is written again inside a batch; a failure before the first write sets none of these fields.
- `confirmDurableBatch(items, { tracker })` is the read-only follow-up in a fresh operation with a new deadline: per file the client VFS and sandbox against the target, and when all agree one tracker settle to `error.batchTracker`; if that settle had to wait, both views are read again and a file no longer at its target fails with `MAKE_CONTENT_CHANGED` (as `_settleMutation` does for one file). Nothing is written.

### Callers

`writeInOrder` (`src/make-batch.js:32`) runs items strictly in order, sending each run of consecutive batchable items through `batch(chunk)` and any other item through `single(item)` at its own position, so import order and "entry files last" hold.

- `make deploy` (`writeFiles`, `src/make-deploy.js:987`, and `writeBatch`, `src/make-deploy.js:889`): non-dependency files per plan order. Dependency files, an unwired entry placeholder and every write of an `--override-make` deploy keep one operation per file (the override checks Make against the plan before each write). Receipt: every file of a batch is recorded uncertain (with a shared `batch` stamp) before the batch starts and replaced by the confirmed writes after it, so a hard stop leaves the whole batch uncertain; resume and abort work from what Make holds, and resume counts the files of that one interrupted batch that landed by content hash (`landedContent`, `src/make-deploy.js` `resumable`), judging each still-uncertain path by its latest uncertain entry, so a second interrupted batch over the same files, or an older unstamped entry for one of them, does not disable the rule. A batch whose error carries `batchTracker` is settled as `writeDurableConfirmed` settles one file: one `confirmDurableBatch` over every file the batch wrote (`completedWrites` and `uncertainWrites`), with the tracker settle. All at main's content: the files the failed operation had confirmed are recorded confirmed, the uncertain ones as confirmed entries with `afterUncertain: true`, and the deploy goes on, writing any file the batch never reached as a new batch, which refuses first if Make changed. The confirmation does not run when any `error.observed` view has `editor: 'different'` or a tree view that does not show the change (`tree: 'absent'` for a write, `'present'` for a delete), the guard `writeDurableConfirmed` applies. That case, an error without `batchTracker` (page refusal, tracker-settle failure, cleanup failure), a file not at its target and a read that fails stop the deploy with the unconfirmed files left uncertain, and `--resume` continues. The marks stay in the receipt until the confirmation has returned. See [deploy.md](deploy.md).
- Solo `make atomicaui add`/`upgrade` (`installSoloRelease`, write loops at `src/commands/make-atomicaui.js:468`): vendor writes and deletes, then app files; `package.json` alone at its position, `VENDOR.json` alone and last.
- `make sync --apply` (`applySync`, `src/make-sync.js:378`) and `make atomicaui release` (`releaseAtomicaui`, `src/commands/make-atomicaui.js:107`).
- `make write`, `make delete`, `make mode`, abort restores and the team-mode paths keep single writes.
