---
title: Deploying GitHub main into Make (make deploy)
description: The repo-admin deploy of main into a team-mode Make file; guards, plan, content comparison, write order, receipt and tag, recovery stages, and the live proof.
date: 2026-10-15
---

Updated 2026-10-15: dependency changes (write order, waiting out Make's own install, lockfiles written through the client) and the CDP timeout for large files.
Updated 2026-10-15: `_vaults/` is repo-only and never deployed.
Updated 2026-10-16: abort ordering, idle rechecks, cumulative receipt bookkeeping, exact saved-tree proof and scratch live validation.

# make deploy

`make deploy` (`src/make-deploy.js`, wired at `src/commands/make.js`) is the one Make write team mode allows. A repo admin runs it in a local clone of `main`. It skips the team-mode write gate and runs its own guards instead (`prepare`, `src/make-deploy.js:376`). Command details are in REFERENCE.md, "Deploying main to Make".

## Guards and base

- Team mode only (`requireTeamMode`, `src/make-deploy.js:360`). The marker is read through the client VFS and must agree with the sandbox copy. Solo files say they have nothing to deploy from.
- Deployers are the repo admins, read through `gh` GET requests (`requireAdmin`, `src/make-deploy.js:172`). There is no deployers list. `main` is unprotected, so the deployed commit must come from a merged pull request (`requireMergedPr`, `src/make-deploy.js:184`).
- The clone must be on a clean `main` equal to `origin/main` after a fetch (`localMain`, `src/make-deploy.js:215`). Install uses `make install` (frozen lockfile, `--ignore-scripts`, kit refusal). The `build` script must pass and leave no file that git sees.
- Make must be idle, in git mode with a baseline, with nothing pending and no unsaved content (`requireMakeReady`, `src/make-deploy.js:240`).
- The base is the tree of the newest `make-deploy/<n>` tag's commit, read with local git (`ls-remote`, then fetching the tag; `tagBase`, `src/make-deploy.js:153`). Anyone who can push tags can write the tag message, so a receipt `mainTree` that differs from the commit's tree is refused, never trusted; `make status` reports it as `receiptMismatch`. The first deploy's base is Make's saved tree. Make differing from the base is make-ahead (`requireBase`, `src/make-deploy.js:255`).
- An unfinished local receipt for the file blocks a new plan. One exception: when Make's saved version is a version that an unfinished receipt saved (`saved-drift`, `tag-clash`), the next plan uses it as the base.

## Plan

- `buildPlan` (`src/make-deploy.js:273`) compares `main`'s tree with Make's saved tree **by blob, ignoring mode**. Listing exposes no file mode, and Make keeps or sets modes its own way. Mode-only differences are listed as `modeOnly`.
- `.npmrc`, `.figma/design-context/` and the repo-only `_vaults/` are never deployed (`alwaysExcluded`, `src/make-deploy.js:43`; `isRepoOnly`, `src/make-project.js:20`). Before, a vault in `main` was refused with `DEPLOY_UNSUPPORTED_PATH` as a new top-level folder (the Hinge deploy). `make status` adds `_vaults/` paths to its out-of-relation set the same way (`src/make-project.js:330`). The marker is excluded when `main` has none, so Make keeps its own. `make status` uses the same exclusion (`markerOutsideMain`, `src/make-project.js`).
- Refused: binary content or files over 2 MiB; LFS paths that differ; new or deleted root files; new top-level folders (the bridge cannot prove absence there; see [persistence.md](persistence.md)); submodules and symbolic links.
- Write order: other files, then the root `package.json`, then the root lockfiles last (`writeRank`, `src/make-deploy.js`). See [Dependency changes](#dependency-changes).
- The digest covers everything except the plan path. Apply re-plans, and the digest, the commit and the free tag number must all still match.

## Dependency changes

Observed live on the scratch file (2026-10-15):
- Make runs its own install in the sandbox 1 to 2.5 s after a client write of `pnpm-lock.yaml` or `package.json`, and rewrites the lockfile to match `package.json`. It never reports busy and never lists the lockfile as pending. Writing the lockfile before `package.json` (the Hinge order) just makes Make put the old one back.
- `createVersion` commits a lockfile only when Make's client wrote it. When the last writer was Make's install, version 31 kept the old lockfile while the working copy held main's; the post-save content check caught it (`DEPLOY_SAVE_UNCERTAIN`, then `saved-drift` at `--verify`). A client write of identical content is enough for the version to keep it (version 32).

So the deploy (`src/make-deploy.js`):
- backs up each planned lockfile's start content before any write (`backupLockfiles`), because Make rewrites it as soon as `package.json` lands; `--abort` needs that backup. A lockfile that already equalled main's at the start has no original (`noOriginal`): it is not backed up, and abort leaves it as Make holds it;
- writes `package.json` after the other files and the lockfiles last, always through the client (`writeDurable(..., { rewrite: true })`, `src/make-client.js`), even when Make already holds main's content;
- waits until Make is idle after each dependency write (`waitIdle`: no busy editor or loading state, and the persistence state and dependency hashes unchanged for 10 s);
- when Make's state moves under a write (`MAKE_PENDING_CHANGED` from the client, nothing written) or a dependency write fails, waits, re-checks every unsaved path against the plan (`plannedState`), then retries that path, at most three times;
- before the save, writes a planned dependency file Make regenerated again (`reconcile`), and stops without saving when Make keeps changing it after three rounds.

Paths outside the plan and unplanned content in other files still refuse. `--resume` and `--abort` accept a planned dependency file Make regenerated; abort restores it from its backup. Abort restores other files first, then `package.json`, then lockfiles, using the existing idle wait and whole-plan check after each dependency write or delete and after a pending-state race (`src/make-deploy.js:872`). It persists the restored list after each path and carries it across retry runs, including recovery of paths an older retry omitted from that list (`src/make-deploy.js:851`). Abort marks the receipt `aborted` only when the working tree equals the original saved tree; otherwise it reports both tree hashes and leaves recovery open (`src/make-deploy.js:901`). `--resume` also writes a lockfile that already holds main's content through the client again, so the version keeps it. A dry run accepts a lockfile that Make's install rewrote to exactly main's content (`requireMakeReady`).

Each `Runtime.evaluate` call used the transport's fixed 5 s timeout, which large writes outlasted (the 377 KB Hinge stylesheet). A call now gets 100 ms more per KiB it sends, and a read may use the operation's remaining time (`payloadTimeout`, `src/make-client.js`).

## Save and tag

- The save is `saveCheckedVersion(..., { listed: true })` (`src/make-client.js`). Make may list pending paths only from the plan. `createVersion` gets exactly Make's listed set. The saved tree must equal the checked working copy **by content**: in the live run, Make kept `100755` on the `pnpm-lock.yaml` it had rewritten, while the working-tree hash had guessed `100644`.
- Root `pnpm-lock.yaml` and `package-lock.json` are missing from Make's rendered tree, the same as dotfiles. Their durable read-back therefore uses client-VFS plus sandbox agreement (`TREE_HIDDEN_ROOT_FILES`, `src/make-durable.js`).
- After the save, a drift check runs over the whole root. Then comes the annotated tag `make-deploy/<n>` on the deployed commit (`pushTag`, `src/make-deploy.js:507`). Its message ends with the receipt's public JSON, which has no local paths. A remote tag under that number counts as this deploy's own, so as pushed, only when it tags the receipt's commit with the receipt's `deployId`; any other holder is a clash. This covers a push that reported failure after GitHub took the ref, and a `--verify` retry. `readGithub` parses that JSON for `make status`.

## Receipts and recovery

Receipts are `figma-cli/make-deploy-receipt@1` files in `~/.figma-cli/deploys/`, mode 0600. They are rewritten at every stage and embed the full plan. Backups are under `deploys/backups/<deployId>/`.

| stage | meaning | next |
|---|---|---|
| `writing`, `written` | no version saved | `--resume`, which needs every planned path at its before or after content and nothing else unsaved; or `--abort`, which restores from backups |
| `saving`, `save-uncertain`, `saved-unverified`, `saved`, `tag-pending` | createVersion may have run | `--verify` only; never save again |
| `saved-drift`, `tag-clash` | the version exists but is not the deploy | the next dry run plans from it |

`--verify` reloads the tab (`reloadPage`). It adopts a version that an unconfirmed save created only when that version's saved content equals `main`; any other version may hold Make edits, so verify fails and leaves the receipt's stage unchanged (never `saved-drift`). It checks the saved content against `main`, pushes a missing tag and appends `fresh-sandbox-verified`. When a version this deploy recorded no longer holds `main`, verify records `saved-drift`, so the receipt stops blocking; the next dry run plans from that version, or meets the make-ahead guard once Make has moved past it. A `tag-pending` receipt already passed the drift check at save time, so verify pushes its tag even when Make has changed since.

## Live proof (2026-10-15)

Run on scratch Make `2X8cYvemgPmUJSZ5GWaeRB` and repo `amelie-pierce/figma-testing-workflow` only.
- First, `make mode team`: version 12 (`2c7ec87e…`). A dry run on the bot-commit `main` refused with `DEPLOY_UNREVIEWED`.
- A test pull request dropped the Make-only `@make-kits` dependency (`make install` refuses it) and changed one line. It was squash-merged as `fd6daad`.
- The dry run planned 3 modified paths, with the marker excluded.
- Apply wrote `package.json`, then stopped on `pnpm-lock.yaml` (`DEPLOY_WRITE_FAILED`). This led to the write-order and hidden-root-file fixes.
- `--resume` wrote the remaining path. Make saved version 13 (`9f09f649…`), but the old tree-SHA check failed on the lockfile mode (`DEPLOY_SAVE_UNCERTAIN`), which led to the content check.
- `--verify` passed after a reload, with `fresh-sandbox-verified`, and pushed `make-deploy/0`. `make status` then read `in-sync` against that tag, and a new dry run found nothing to deploy.
- `make mode solo` restored solo mode: version 14 (`2c27a9b9…`), whose tree `325a77ff…` equals `main`'s tree exactly.
- Dependency change, scratch PR 10 (`tiny-invariant`): the first apply wrote all 5 paths but version 31 kept the old lockfile (see [Dependency changes](#dependency-changes)). After the fix, a dry run planned only `pnpm-lock.yaml` from that version; apply saved version 32 (`make-deploy/4`) and `--verify` passed.
- Dependency change, scratch PR 12 (`dequal`), one uninterrupted apply: lockfile backup, 2 source files, `package.json`, `pnpm-lock.yaml`; version 33, `make-deploy/5`; `--verify` passed with `fresh-sandbox-verified`.
- Abort was proven live on the same scratch file with main `dd6d947`: an interrupted 12-path apply wrote `package.json` and `pnpm-lock.yaml`, then `--abort` restored all 12 paths without saving. Receipt `20261016T023848Z-2X8cYvemgPmUJSZ5GWaeRB-dd6d947` ended `aborted`; saved version `ce5d426` was unchanged, pending was 0, and working and saved trees both equalled `f366521` (`src/make-deploy.js:843`, `tests/make-deploy.test.js:958`).
- A second interrupted apply and abort on the same scratch file proved retry bookkeeping: receipt `20261016T024442Z-2X8cYvemgPmUJSZ5GWaeRB-dd6d947` held six restored paths after the first abort was interrupted and 12 after `--abort` was rerun. It again ended with pending 0 and working tree `f366521`, equal to the unchanged saved tree (`src/make-deploy.js:851`, `tests/make-deploy.test.js:616`).
- Not proven live: a tag clash. Integration tests cover it.

Tests: `tests/make-deploy.test.js` uses a stateful fake Make, fake `gh` and `pnpm`, and local bare repos. Also see `tests/make-durable.test.js` and `tests/make-project.test.js`.
