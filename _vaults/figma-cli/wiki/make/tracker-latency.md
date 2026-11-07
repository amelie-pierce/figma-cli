---
title: Make pending tracker latency
description: Why a confirmed write can precede the pending set, and how guards wait without accepting unrelated changes.
date: 2026-11-07
---

# Diagnosis

Updated 2026-11-07. Trigger: a client-VFS write completes and editor, tree,
client VFS and sandbox agree. Masking condition: React's `codeFileChanges`
still describes the previous working copy, with `isLoading: false`. Symptom:
the next write sees two different pending snapshots, or an immediate save sees
an empty pending set. Content agreement and tracker agreement are distinct
signals (`src/make-client.js:679`, `src/make-client.js:818`,
`src/make-persistence.js:25`).

Scratch-only reproduction on `Iv9p3539krJZZ4MZsDjjfg`, 2026-11-07 UTC:
`src/benchmark/04.txt` returned `editor-tree-vfs-sandbox-matched` at
02:25:42.094 after a 2303 ms write. An immediate save refused 8 ms later:
`expected ["src/benchmark/04.txt"], found []`. Polls still found an empty set
1196 and 1411 ms after confirmation; the first matching sample was at 1517 ms.
All samples had `isLoading: false`. Thus the observed transition is bounded by
1411–1517 ms after content confirmation, not a write failure. The opt-in
regression runner repeats the two failing workflow shapes and checks a fresh
reload (`tests/live/make-tracker-lag.mjs:1`).

## Guard map and repair

The CLI routes `make write` through `writeDurableConfirmed`, `make delete`
through `deleteDurable`, and ordinary `make save-version` through
`saveVersion` (`src/commands/make.js:272`, `src/commands/make.js:284`,
`src/commands/make.js:307`). Deploy writes use the same client; resume reads
`projectStatus` before checking the receipt (`src/make-deploy.js:1164`).

- The pre-write and pre-delete guards still require the saved version and
  pending paths to equal their earlier snapshot. SHA and page-side content
  guards remain in place (`src/make-client.js:818`, `src/make-client.js:937`,
  `src/make-durable.js:84`).
- After content verification, `_pendingAfterMutation` derives the exact
  expected pending set from the saved entry and the new bytes or absence.
  Restoring saved bytes, or deleting a newly created file, removes the path.
  The saved version's flattened tree is read once and reused until the saved
  version or connection changes, so a deploy does not reload a packed sandbox
  for every file; it reads no source blobs (`src/make-client.js:602`).
- `_settleTracker` polls the same persistence signal every 100 ms within the
  existing operation deadline. It pins the saved version, permits the known
  previous set while waiting, and refuses foreign paths or disappearance of
  unrelated pending paths. Hidden paths and no-baseline files retain their
  existing special verification rules (`src/make-client.js:570`).
- `saveVersion` waits for missing expected paths before applying the unchanged
  exact-set check and the page-side `createVersion` guard. The allowlist for
  unlisted instruction files is unchanged (`src/make-client.js:985`,
  `src/make-durable.js:41`, `src/make-durable.js:162`).
- Tracker failures after confirmed writes have distinct error codes, so deploy
  cannot mistake them for a pre-write `MAKE_PENDING_CHANGED` refusal and replay
  the mutation. Uncertain-write read-back also settles the tracker before
  reporting success (`src/make-client.js:42`, `src/make-client.js:858`).
  A dependency retry rechecks the planned content and does not rewrite a
  confirmed lockfile write or delete merely because settlement timed out.
- Inventory snapshots still have to agree at every boundary. A pending-only
  transition discards the partial read, uses the same settlement helper, and
  restarts the complete read with one shared recovery deadline. Version,
  mode, error and malformed-state changes still fail closed. This covers
  project status and project inventory; vendor inventory keeps its
  fail-closed refusal (`src/make-client.js:52`, `src/make-client.js:624`).
- Deploy resume calls `projectStatus`, so it receives the coherent inventory
  after settlement; `plannedState` still checks all unsaved content and pending
  paths against the reviewed plan (`src/make-deploy.js:1164`,
  `src/make-deploy.js:791`). No prototype was used for live validation.
- The deploy save (`saveCheckedVersion` with `listed`) derives the listed set
  from the saved tree and the checked working copy, then settles the tracker
  to it before pinning the state passed to `createVersion`. A resume whose
  status read an empty pending set while the tracker still lagged no longer
  refuses; foreign paths and version changes still do.
- Deploy resume and abort, after their plan and content checks, wait through
  `settleListedPending` for Make to list exactly that checked unsaved content
  before the next write or delete, so a confirmed but not yet listed write
  is neither replayed nor later rejected as foreign.
- When an override's saved commit object is missing from the sandbox, the
  expected pending list comes from the saved inventory the plan recovered from
  the deploy record (`overridePin.savedFiles`), for writes, deletes, resume
  and the save; the live runner refuses a scratch file with any unsaved
  content, listed or not (such as `AGENTS.md`).

The DOM error `Make file tree changed before the requested action` is a
separate row/ancestry identity guard, not a read of `codeFileChanges`.
Its existing known-path insertion/removal retry remains unchanged. The
pending-lag reproduction does **not** establish that every historical DOM
refusal had this cause (`src/make-tree.js:154`, `src/make-tree.js:356`).

## Validation

Fake regressions execute public write/save/status methods with delayed tracker
updates, foreign paths, changed versions, non-settlement, restored saved bytes
and continuous inventory churn. Six new regressions failed against the
pre-fix client, including the immediate save and mid-inventory transition;
all 126 focused fixed checks passed (`tests/make-durable.test.js:1171`,
`tests/make-project-client.test.js:231`). Existing deploy recovery tests still
reject unrelated edits (`tests/make-deploy.test.js:1435`).

The first live run completed all 14 writes (`04`–`10` with save after each,
then the same paths serially without saves), seven individual saves and one
batch save, without refusals. Version 12, commit
`8525f99612992b0648e9eeae570278f248a51886`, had zero pending paths after a fresh
reload; all seven hashes matched and all 27 non-benchmark files were unchanged.
A second live run with the then-current implementation (a per-path
saved-entry lookup, since replaced) repeated all 14 writes and eight saves
successfully. At 02:38:55 UTC its fresh-reload
check passed at version 20 (`61a5d9e4d30fa625400b68f833156d5fca179260`), with
zero pending paths, all seven expected hashes and the same 27 non-benchmark
file hashes. Tracker waits after content confirmation ranged from 1157 to 1529 ms.
No installed runtime was updated and no prototype received traffic.
The later follow-up (cached saved-version tree, deploy-save settlement,
no lockfile replay after confirmed mutations, resume/abort settlement, and a live runner that refuses a
scratch file with pending changes instead of saving them) was validated
offline only with fake clients; it has no live run yet.

The final full Make suite passed 644/644 tests, with no skips, under Node
24.15.0 (578.697 s); the focused durable/tree/inventory/git checks passed
126/126. The Make suite is the offline runner in `tests/run-make-tests.mjs:6`;
the live runner is separately opt-in.
