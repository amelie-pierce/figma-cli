---
title: Large source files, size warnings and filesystem timeouts
description: Make filesystem request timeouts and the warn-only size rule on make status and make deploy.
date: 2026-11-04
---

# Large source files, size warnings and filesystem timeouts

Durable CDP waits are separate from the filesystem request cap below; see [the command reference](../../../../REFERENCE.md#make-saving-modes-and-write-commands).

Make reads and saves every file whole over its filesystem socket ([filesystem-bridge.md](filesystem-bridge.md)). One huge module is therefore the slowest request in any status, deploy or read. The ADC prototype's `Workspace.tsx` (about 493 KB, about 372 KB of it inline base64 PNGs) made `make status` fail with "Make filesystem request timed out; outcome is unknown."

## The per-request cap, not the command timeout

- `make status` already defaulted to `--timeout 120000` (`src/commands/make.js:199` before this change). The idea that a 15 s default timed out was wrong: 15000 is the default of `MakeClient` and of most other `make` commands (`src/make-client.js` constructor, `target()` in `src/commands/make.js`).
- The real fixed limit was inside the bridge. `_fileBridge` armed the page-side bridge with `Math.min(5000, remaining)` as `timeoutMs`, and `captureMakeFileSocket` uses that as every request's timer (`src/make-rpc.js:140`). So each filesystem request had 5 s whatever `--timeout` said; a later status that worked was not caused by `--timeout 120000`.
- Now each request may use the operation's remaining time less one second, so the page reports its own timeout before the CDP call does (`bridgeRequestTimeout`, `src/make-client.js:53`, the default of `_fileBridge`'s `requestTimeoutMs`). The exception is an absence check (`_durableAgreement` with `expectedContent === null`): Make never answers a listing of a missing folder, so its parent-walk opens the bridge with `Math.min(5000, remaining)` and each missing level still costs at most about 5 s (test: `tests/make-durable.test.js`). An inventory runs one `_operation` per batch of 24 entries (`inventoryProject`), so each batch gets the full `--timeout`; `make status` instead shares one wall deadline across connection and every batch (`runStatusBudget`, `src/make-status-budget.js`; budget in REFERENCE.md).
- Read-only `make read` adds a hint to a timeout error (`timeoutHint`, `src/make-client.js:57`; `withClient(..., { readOnly: true })` in `src/commands/make.js`); `make status` adds its own wall-budget hint there instead. Writes never get it: a timed-out write has an unknown outcome and must not just be run again.

## Size warnings (warn only)

- Rule and thresholds: `src/make-size.js` (150 KB, 1500 lines, 50 KB inline base64). Skipped: `vendor/`, `public/`, `docs/`, `guidelines/`, asset and generated modules, `.d.ts`, `.min.*`.
- `make deploy` dry run and apply check every file of `main` that is not deploy-ignored, reading content (`prepare`, `src/make-deploy.js:620`); the dry-run result carries `sizeWarnings`. The plan and digest do not change.
- `make status` knows only byte sizes (`workingBytes`, `src/make-client.js:1315`), so it checks size alone (`src/commands/make.js:220`). Warnings go to stderr and the JSON; the exit code is unchanged.
- Designer-facing wording lives in `skills/figma-make-team/SKILL.md` ("Keep files small").

## Tree scan on a mostly collapsed tree (Updated 2026-11-11)

- Before every `writeDurable`, `_durableAgreement` does a full `scanTree` (`src/make-tree.js:245`, `src/make-client.js:795`). With no `targetPath` it expands each collapsed folder it meets. It used to restart the whole pass after every click, so a tree of ~160 collapsed folders cost O(folders x rows) evaluations and outlived the 120 s operation cap ("Timed out while reading the Make file tree.").
- Now, when a click's own re-read shows the folder expanded and the content taller, the scan drops only the rows at or below that folder and continues the same pass. Any other result still restarts from the top. `targetPath` scans (selection) are unchanged. Cost is one evaluation per folder plus one per viewport step (test: `tests/make-tree.test.js`, "Make tree scan with many collapsed folders").
- Scans are not shared across writes of one deploy: each write is its own `_operation` with its own deadline, and the pre-write scan is the live tree view of the three-view agreement. A cached snapshot from the previous write could not prove the tree is unchanged without rescanning, so each write keeps its own (now cheap) scans; within one write the ancestor check's listing is already reused (`treeState.prefetched`).

## Waiting for lazy children and the up-front expand-all (Updated 2026-11-11)

- Make marks a clicked folder expanded at once but fills its children lazily over the filesystem bridge (~0.4 s per request). The expand click used to re-read after 40 ms, saw no growth, and `scanTree` fell back to a restart per folder: a cold ADM tree (704 entries, 159 folders) took 97 s, an expanded one 4 s.
- Now an untargeted expand passes `waitMs` (at most `EXPAND_WAIT_MS` = 2 s, `src/make-tree.js:259`, capped by the scan's remaining time less 0.5 s, `:314`) and the page-side `treeDOMAction` (`:227`) polls every 50 ms until the clicked folder shows expanded and `contentHeight` grew, then returns. On the cap it returns what it sees and the old restart applies. `targetPath` scans send `waitMs: 0` and are unchanged, as are all guards. Evaluations stay O(folders + rows) because the wait is inside the click's one evaluation (test: `tests/make-tree.test.js`, lazy-children case with a fake page clock).
- `writePlan` (`src/make-deploy.js:1238`, top of the function, so apply and resume both run it) calls `MakeClient.expandTree()` (`src/make-client.js:566`) once before the first write. That is its own `_operation` with its own `timeoutMs`, not part of any per-write 120 s operation, so the pre-write scan of each write finds an expanded tree. It only reads and clicks folders; the durable three-view check is untouched.
- A failed or timed-out expand-all stops the deploy with `DEPLOY_WRITE_FAILED` ("Could not expand the Make file tree before writing") before any write, since nothing is written yet and `--resume` is safe. It is recorded as `receipt.expandTree` ({entries, folders}) and a progress line. Tests: `tests/make-deploy.test.js`.
