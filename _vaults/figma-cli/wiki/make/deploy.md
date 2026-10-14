---
title: Deploying GitHub main into Make (make deploy)
description: The repo-admin deploy of main into a team-mode Make file; guards, plan, content comparison, write order, receipt and tag, recovery stages, and the live proof.
date: 2026-10-15
---

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
- `.npmrc` and `.figma/design-context/` are never deployed. The marker is excluded when `main` has none, so Make keeps its own. `make status` uses the same exclusion (`markerOutsideMain`, `src/make-project.js`).
- Refused: binary content or files over 2 MiB; LFS paths that differ; new or deleted root files; new top-level folders (the bridge cannot prove absence there; see [persistence.md](persistence.md)); submodules and symbolic links.
- Write order: lockfiles first, then other files, then the root `package.json` last. Make reinstalls when `package.json` changes. In the live run, writing `package.json` first made Make's own install rewrite `pnpm-lock.yaml` mid-write, and the write's pre-check timed out.
- The digest covers everything except the plan path. Apply re-plans, and the digest, the commit and the free tag number must all still match.

## Save and tag

- The save is `saveCheckedVersion(..., { listed: true })` (`src/make-client.js`). Make may list pending paths only from the plan. `createVersion` gets exactly Make's listed set. The saved tree must equal the checked working copy **by content**: in the live run, Make kept `100755` on the `pnpm-lock.yaml` it had rewritten, while the working-tree hash had guessed `100644`.
- Root `pnpm-lock.yaml` and `package-lock.json` are missing from Make's rendered tree, the same as dotfiles. Their durable read-back therefore uses client-VFS plus sandbox agreement (`TREE_HIDDEN_ROOT_FILES`, `src/make-durable.js`).
- After the save, a drift check runs over the whole root. Then comes the annotated tag `make-deploy/<n>` on the deployed commit (`pushTag`, `src/make-deploy.js:495`). Its message ends with the receipt's public JSON, which has no local paths. `readGithub` parses that JSON for `make status`.

## Receipts and recovery

Receipts are `figma-cli/make-deploy-receipt@1` files in `~/.figma-cli/deploys/`, mode 0600. They are rewritten at every stage and embed the full plan. Backups are under `deploys/backups/<deployId>/`.

| stage | meaning | next |
|---|---|---|
| `writing`, `written` | no version saved | `--resume`, which needs every planned path at its before or after content and nothing else unsaved; or `--abort`, which restores from backups |
| `saving`, `save-uncertain`, `saved-unverified`, `saved`, `tag-pending` | createVersion may have run | `--verify` only; never save again |
| `saved-drift`, `tag-clash` | the version exists but is not the deploy | the next dry run plans from it |

`--verify` reloads the tab (`reloadPage`). It adopts a version that an unconfirmed save created only when that version's saved content equals `main`; any other version may hold Make edits, so verify fails and leaves the receipt's stage unchanged (never `saved-drift`). It checks the saved content against `main`, pushes a missing tag and appends `fresh-sandbox-verified`.

## Live proof (2026-10-15)

Run on scratch Make `2X8cYvemgPmUJSZ5GWaeRB` and repo `amelie-pierce/figma-testing-workflow` only.
- First, `make mode team`: version 12 (`2c7ec87e…`). A dry run on the bot-commit `main` refused with `DEPLOY_UNREVIEWED`.
- A test pull request dropped the Make-only `@make-kits` dependency (`make install` refuses it) and changed one line. It was squash-merged as `fd6daad`.
- The dry run planned 3 modified paths, with the marker excluded.
- Apply wrote `package.json`, then stopped on `pnpm-lock.yaml` (`DEPLOY_WRITE_FAILED`). This led to the write-order and hidden-root-file fixes.
- `--resume` wrote the remaining path. Make saved version 13 (`9f09f649…`), but the old tree-SHA check failed on the lockfile mode (`DEPLOY_SAVE_UNCERTAIN`), which led to the content check.
- `--verify` passed after a reload, with `fresh-sandbox-verified`, and pushed `make-deploy/0`. `make status` then read `in-sync` against that tag, and a new dry run found nothing to deploy.
- `make mode solo` restored solo mode: version 14 (`2c27a9b9…`), whose tree `325a77ff…` equals `main`'s tree exactly.
- Not proven live: a single uninterrupted `--apply` run with the fixed write order, `--abort`, and a tag clash. Integration tests cover these.

Tests: `tests/make-deploy.test.js` uses a stateful fake Make, fake `gh` and `pnpm`, and local bare repos. Also see `tests/make-durable.test.js` and `tests/make-project.test.js`.
