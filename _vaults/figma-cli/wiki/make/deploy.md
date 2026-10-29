---
title: Deploying GitHub main into Make (make deploy)
description: The repo-admin deploy of main into a team-mode Make file; guards, plan, content comparison, write order, receipt and tag, recovery stages, and the live proof.
date: 2026-10-15
---

Updated 2026-10-15: dependency changes (write order, waiting out Make's own install, lockfiles written through the client) and the CDP timeout for large files.
Updated 2026-10-15: `_vaults/` is repo-only and never deployed.
Updated 2026-10-16: abort ordering, idle rechecks, cumulative receipt bookkeeping, exact saved-tree proof and scratch live validation.
Updated 2026-10-16: guarded tree refresh after a new file creates folders or a delete empties them.
Updated 2026-10-24: the committed deploy ignore list `.figma-cli/deploy-ignore`, read-only evidence on Make's root writes, and the LMA dry run.
Updated 2026-10-24: `.figma/make/` is always excluded, and the built-in exclusions match files below their folders.
Updated 2026-10-24: deletes run after the other writes, and a create may re-enter a planned top-level folder an earlier delete emptied (the LMA apply stop).
Updated 2026-10-29: current-main override is documented in the command reference; live save behavior remains unverified.
Updated 2026-10-29: a missing saved commit can use the newest validated annotated deploy tag when no usable local receipt exists.
Updated 2026-10-29: status marks a missing saved commit even when Make claims a baseline; verify waits for the reloaded code panel and sandbox filesystem before reading.

# make deploy

## Current-main override

For commands, guards and recovery, see the
[current-main override contract](../../../../REFERENCE.md#deploying-main-to-make-make-deploy).
The live `createVersion` behavior with a broken tracker is **UNVERIFIED**;
coverage uses fake Make (`tests/make-deploy.test.js`, `tests/make-durable.test.js`).
When the saved sandbox commit is missing, override reconstructs its inventory from a completed local receipt or, if none is usable, the newest annotated deploy tag. The tag record must identify the file and repo, match Make's saved pointer, and name the tagged commit's tree; protected paths use blob IDs without reading contents (`src/make-deploy.js:172`, `src/make-deploy.js:190`, `src/make-deploy.js:217`). This tag fallback has fake coverage only (`tests/make-deploy.test.js:479`).
`projectStatus` reports `savedMissing` and uses the sandbox head if the claimed saved commit is absent (`src/make-client.js:1165`); override planning, apply and verify then use the recorded inventory fallback (`src/make-deploy.js:248`, `src/make-deploy.js:597`, `src/make-deploy.js:1260`). After reload, verify probes the code panel and a small sandbox file with bounded backoff before its status read (`src/make-client.js:947`, `src/make-deploy.js:559`). These paths have fake coverage only (`tests/make-deploy.test.js`, `tests/make-project-client.test.js`).

`make deploy` (`src/make-deploy.js`, wired at `src/commands/make.js`) is the one Make write team mode allows. A repo admin runs it in a local clone of `main`. It skips the team-mode write gate and runs its own guards instead (`prepare`, `src/make-deploy.js:568`). Command details are in REFERENCE.md, "Deploying main to Make".

## Guards and base

- Team mode only (`requireTeamMode`, `src/make-deploy.js:552`). The marker is read through the client VFS and must agree with the sandbox copy. Solo files say they have nothing to deploy from.
- Deployers are the repo admins, read through `gh` GET requests (`requireAdmin`, `src/make-deploy.js:312`). There is no deployers list. `main` is unprotected, so the deployed commit must come from a merged pull request (`requireMergedPr`, `src/make-deploy.js:324`).
- The clone must be on a clean `main` equal to `origin/main` after a fetch (`localMain`, `src/make-deploy.js:355`). Install uses `make install` (frozen lockfile, `--ignore-scripts`, kit refusal). The `build` script must pass and leave no file that git sees.
- A normal deploy requires Make to be idle, in git mode with a baseline, with nothing pending and no unsaved content (`requireMakeReady`, `src/make-deploy.js:382`).
- The base is the tree of the newest `make-deploy/<n>` tag's commit, read with local git (`ls-remote`, then fetching the tag; `tagBase`, `src/make-deploy.js:293`). Anyone who can push tags can write the tag message, so a receipt `mainTree` that differs from the commit's tree is refused, never trusted; `make status` reports it as `receiptMismatch`. The first deploy's base is Make's saved tree. A normal deploy refuses Make differing from the base as make-ahead (`requireBase`, `src/make-deploy.js:399`).
- An unfinished local receipt for the file blocks a new plan. For a normal deploy, when Make's saved version is a version that an unfinished receipt saved (`saved-drift`, `tag-clash`), the next plan uses it as the base.

## Plan

- For a normal deploy, `buildPlan` (`src/make-deploy.js:424`) compares `main`'s tree with Make's saved tree **by blob, ignoring mode**. Listing exposes no file mode, and Make keeps or sets modes its own way. Mode-only differences are listed as `modeOnly`.
- `.npmrc`, `.figma/design-context/`, Make's own config `.figma/make/` and the repo-only `_vaults/` are never deployed (`alwaysExcluded`, `src/make-deploy.js:79`; `MAKE_MANAGED` and `isRepoOnly`, `src/make-project.js`). Like the ignore list, these rules match a path or any of its folders, so files under `.figma/design-context/` and `.figma/make/` are excluded, not only the folders. `.figma/make/` is a deploy-only rule, not part of `PROJECT_EXCLUDES`: Make's saved tree tracks it, so it stays in the inventory and the tree hashes, and `make status` is unchanged. Before, a vault in `main` was refused with `DEPLOY_UNSUPPORTED_PATH` as a new top-level folder (the Hinge deploy). `make status` adds `_vaults/` paths to its out-of-relation set the same way (`src/make-project.js:330`). The marker is excluded when `main` has none, so Make keeps its own. `make status` uses the same exclusion (`markerOutsideMain`, `src/make-project.js`).
- `main` may commit `.figma-cli/deploy-ignore` (`DEPLOY_IGNORE`, `src/make-deploy.js:93`): gitignore lines parsed by the shared `parseIgnore`, matched against a path and each of its folders, so `/docs/` covers everything below it (`ignoreMatcher`, `src/make-deploy.js:100`). The list itself is always ignored. An ignored path is listed under `excluded` with a side-specific reason (`ignoredReason`, `src/make-deploy.js:408`) before any other check, so it is never written, created or deleted: repo-only files stay in GitHub, Make-only files (Make's root `AGENTS.md`, `CLAUDE.md`, `.gitattributes`, `.mise.toml`) stay in Make. The plan records `ignore{path,blob,patterns}` (`src/make-deploy.js:523`), so the digest covers the list, and `excludedCount` appears in the dry run, receipt, tag JSON and results. The normal make-ahead check skips paths named by `main`'s or the base tag's list (`src/make-deploy.js:633`): a path the last deploy never wrote is not Make's edit. The post-save and `--verify` drift checks skip the plan's excluded paths plus its patterns, so a Make-only file the list names that appears later does not fail verify (`skipOf`, `src/make-deploy.js:533`). Everything else meets the unchanged guards: dropping a pattern after a deploy turns that path back into a refused root delete, not make-ahead (`tests/make-deploy.test.js:1735`). A list that is not UTF-8 refuses with `DEPLOY_IGNORE`. Tests: `tests/make-deploy.test.js:1627`.
- Refused: binary content or files over 2 MiB; LFS paths that differ; new or deleted root files; new top-level folders (the bridge cannot prove absence there; see [persistence.md](persistence.md)); submodules and symbolic links.
- Write order: new and changed files, then deletes, then the root `package.json`, then the root lockfiles last (`writeRank`, `src/make-deploy.js:56`). The plan lists files in that order. Abort undoes adds with deletes, so it restores changed and deleted files first (`byRestoreOrder`, `src/make-deploy.js:60`). See [Dependency changes](#dependency-changes) and [Emptied top-level folders](#emptied-top-level-folders).
- The digest covers everything except the plan path. Apply re-plans, and the digest, the commit and the free tag number must all still match.

## Root files and new top-level folders

The root refusal is figma-cli's own rule, not a proven Make limit. A new file's absence is proven by listing its nearest existing ancestor, never the project root (`_requireListableAncestor`, `src/make-client.js:542`). Read-only inspection of Lab Management Application (`YBej9OBlqmwTX236XolhZj`, Desktop port 9333, 2026-10-24): the single client VFS exposes `writeFile`, `deleteFile`, `createDirectory`, `deleteDirectory` and `fetchEntry`; `writeFile` and `deleteFile` only forward `{ type, path }` to the storage adapter's `writeBatch`, with no root check; `fileProtectionPolicy` was `none`; `fetchEntry` returned files for root `AGENTS.md`, `CLAUDE.md`, `.gitattributes`, `.mise.toml` and `package.json`, and null for `/README.md`, `/playwright.config.ts`, `/docs`, `/scripts` and `/tests`. So the client VFS could prove root absence. Whether a root create or delete persists through `createVersion` is `UNVERIFIED`: proving it needs a write. The guard is unchanged; repo-only and Make-only root paths go in the ignore list instead.

## Emptied top-level folders

The first LMA apply (figma-cli `8c9f907`, plan digest `1bb64dbf`, 79 add, 7 modify, 4 delete) stopped after 4 of 90 writes with `DEPLOY_WRITE_FAILED`: "Make cannot prove public/fonts/OFL.txt absent". The old order put `delete public/favicon.svg`, Make's only file in `public/`, before the adds. Make then dropped `public/` from its rendered tree, and the guard refuses a create whose top-level folder is not in the tree. Receipt `20261024T091126Z-YBej9OBlqmwTX236XolhZj-80c627d` holds those 4 writes (`.github/workflows/build.yml`, `.gitignore`, `index.html`, the favicon delete) with no version saved.

Two changes fix it:
- Deletes run after the new and changed files (see the write order above), so an apply never empties a folder that later writes need.
- `writeDurable(..., { baseFolders })` (`src/make-client.js:542`, `src/make-client.js:653`). A create below a top-level folder named in `baseFolders` may go ahead when that folder is missing from the tree, nothing at all is rendered at its name, and Make's `fetchEntry` finds no file at the path. The usual pre-write VFS, sandbox and tree absence check and the guarded tree refresh still run. The deploy passes the top-level folders of its planned paths (`baseFolders`, `src/make-deploy.js:64`). Each of those folders held Make files when the plan was built, because a new top-level folder is refused. So `--resume` of that receipt can create the `public/` files, and `--abort` can restore `public/favicon.svg`. Deletes keep the original guard. Root files and folders outside the plan refuse as before. The receipt format is unchanged.

Read-only live check on Lab Management Application (Desktop port 9333, 2026-10-24), after the stop: saved version `fac6269a…` still equals the receipt's `makeBefore`; the rendered tree's top level is `src` plus root files, with no `public`; `fetchEntry` is null for `public/favicon.svg` and `public/fonts/OFL.txt`. The guard refused `public/fonts/OFL.txt` with no base folders, allowed it with `.github`, `public` and `src`, and still refused `docs/x.md`. `classify` of the receipt read 4 paths at `after`, 86 at `before`, none `other`, and nothing unsaved outside the plan. The real `--resume` is the live proof, and no write was made for this check.

Tests: `tests/make-deploy.test.js:1781` replays the sequence through a fake Make that runs the real guard (apply, the 8c9f907 receipt resumed and aborted, new folders and root files still refused); `tests/make-tree.test.js:420` runs the real `writeDurable` with a top-level folder that appears again.

## LMA dry run (2026-10-24)

Read-only, against Lab Management Application at saved version `fac6269a…`, tree `9d2bb48a…`, with a scratch copy of `amelie-pierce/lma-design-prototype` main `8f70978` plus one local commit adding the ignore list. The origin URL and the merged-PR lookup for that local commit were stubbed; the Make read, install, build and admin check were real. Without the list the same main refused with 57 unsupported paths. With `/docs/ /scripts/ /tests/ /README.md /playwright*.config.ts /.gitattributes /.mise.toml /AGENTS.md /CLAUDE.md`: 0 unsupported, 68 new, 7 changed, 13 deleted, 63 excluded, base `first-deploy`, tag `make-deploy/0`. Nine of the deletes were Make's own `.figma/make/*` files (`dev.json`, `site.json`, `deploy` and others), so `.figma/make/` is now always excluded; adding `/.figma/make/` to the list (the same result as the built-in rule now gives) left 68 new, 7 changed, 4 deleted (`public/favicon.svg`, `src/App.tsx`, `src/index.css`, `src/vite-env.d.ts`) and 72 excluded. Make's saved version and pending count were unchanged afterwards.

## Folder changes during writes and deletes

For a new durable file, the client retains the complete rendered tree from its pre-write absence check. After Make accepts the VFS write, the shared tree traversal may reread once if a guarded row action sees a changed tree. It compares the fresh complete tree with that snapshot: only the written file and its missing ancestor folders may appear; existing paths, kinds, levels and row heights must remain. A durable delete (deploy deletes, abort removals, library replacement) retains its pre-delete tree the same way: only the deleted file and ancestor folders left with no rows beneath them may disappear, and nothing may appear. Other changes keep the original refusal. The VFS, sandbox and editor byte checks still run (`src/make-client.js:568`, `src/make-client.js:635`, `src/make-client.js:673`, `src/make-tree.js:303`, `src/make-tree.js:341`). Fake-Make coverage runs the real `writeDurable` and `deleteDurable` through the guarded refresh: a new folder and an emptied folder continue, while an unrelated insertion or removal refuses (`tests/make-tree.test.js:375`). Tree-level tests cover the same cases (`tests/make-tree.test.js:165`, `tests/make-tree.test.js:210`). The deploy test at `tests/make-deploy.test.js:809` runs only the tree check from its hooks, beside a fake client, for twelve new folders.

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

Paths outside the plan and unplanned content in other files still refuse. `--resume` and `--abort` accept a planned dependency file Make regenerated; abort restores it from its backup. Abort restores other files first, then `package.json`, then lockfiles, using the existing idle wait and whole-plan check after each dependency write or delete and after a pending-state race (`src/make-deploy.js:1120`). It persists the restored list after each path and carries it across retry runs, including recovery of paths an older retry omitted from that list (`src/make-deploy.js:1094`). Abort marks the receipt `aborted` only when the working tree equals the original saved tree; otherwise it reports both tree hashes and leaves recovery open (`src/make-deploy.js:1167`). When only a lockfile Make's install changed before the deploy (no original backup) still differs, it names the path with its working sha256 and saved blob and stops without a rerun: let Make finish its install from `package.json`, check `make status`, and if the lockfile still differs restore the saved version from Make's version history (no hand edit); once it matches, one more `--abort` closes the receipt. Cross-run recovery does not count a path whose only apply write was uncertain as restored; when it is back at saved content it is listed apart as `restoredUncertain` in the receipt and the abort result. `--resume` also writes a lockfile that already holds main's content through the client again, so the version keeps it. A dry run accepts a lockfile that Make's install rewrote to exactly main's content (`requireMakeReady`).

Each `Runtime.evaluate` call used the transport's fixed 5 s timeout, which large writes outlasted (the 377 KB Hinge stylesheet). A call now gets 100 ms more per KiB it sends, and a read may use the operation's remaining time (`payloadTimeout`, `src/make-client.js`).

## Save and tag

- The save is `saveCheckedVersion(..., { listed: true })` (`src/make-client.js`). Make may list pending paths only from the plan. `createVersion` gets exactly Make's listed set. The saved tree must equal the checked working copy **by content**: in the live run, Make kept `100755` on the `pnpm-lock.yaml` it had rewritten, while the working-tree hash had guessed `100644`.
- Root `pnpm-lock.yaml` and `package-lock.json` are missing from Make's rendered tree, the same as dotfiles. Their durable read-back therefore uses client-VFS plus sandbox agreement (`TREE_HIDDEN_ROOT_FILES`, `src/make-durable.js`).
- After the save, a drift check runs over the whole root. Then comes the annotated tag `make-deploy/<n>` on the deployed commit (`pushTag`, `src/make-deploy.js:861`). Its message ends with the receipt's public JSON, which has no local paths. A remote tag under that number counts as this deploy's own, so as pushed, only when it tags the receipt's commit with the receipt's `deployId`; any other holder is a clash. This covers a push that reported failure after GitHub took the ref, and a `--verify` retry. `readGithub` parses that JSON for `make status`.

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
- Abort was proven live on the same scratch file with main `dd6d947`: an interrupted 12-path apply wrote `package.json` and `pnpm-lock.yaml`, then `--abort` restored all 12 paths without saving. Receipt `20261016T023848Z-2X8cYvemgPmUJSZ5GWaeRB-dd6d947` ended `aborted`; saved version `ce5d426` was unchanged, pending was 0, and working and saved trees both equalled `f366521` (`src/make-deploy.js:1080`, `tests/make-deploy.test.js:1345`).
- A second interrupted apply and abort on the same scratch file proved retry bookkeeping: receipt `20261016T024442Z-2X8cYvemgPmUJSZ5GWaeRB-dd6d947` held six restored paths after the first abort was interrupted and 12 after `--abort` was rerun. It again ended with pending 0 and working tree `f366521`, equal to the unchanged saved tree (`src/make-deploy.js:1094`, `tests/make-deploy.test.js:942`).
- Not proven live: a tag clash. Integration tests cover it.

Tests: `tests/make-deploy.test.js` uses a stateful fake Make, fake `gh` and `pnpm`, and local bare repos. Also see `tests/make-durable.test.js` and `tests/make-project.test.js`.
