---
name: atomicaui-release
description: Release a new AtomicAUI version. Brings the AtomicAUI components (and their guides) from the workspace repo's main into the AtomicAUI Make kit as one checked, saved kit update, then cuts an immutable hosted release with make atomicaui release and verifies it after the person republishes the kit site. Use when someone with edit access to the kit says "release a new AtomicAUI", "bring the latest AtomicAUI into the kit", "cut AtomicAUI X.Y.Z" or "what changed in AtomicAUI since the last release". Stops for the person at every decision and for the site's Unpublish/Publish click.
---

# Release a new AtomicAUI

AtomicAUI is built in a workspace repo on GitHub and travels to apps through a
Figma Make **kit** file: the kit vendors the library under
`src/vendor/atomic-aui/` (recorded in its `VENDOR.json`), keeps component guides
under `guidelines/components/`, and serves immutable releases from its published
site under `public/atomicaui/`. Prototypes then upgrade with the
`atomicaui-upgrade-prototype` skill.

Anyone with **edit access to the kit** and **read access to the workspace repo**
may release. This skill checks what it can (`make status`, `gh`) and says so when
a right is missing; it never grants rights.

Command recipes (the one-liners, request JSON, helper flags) are in
[references/commands.md](references/commands.md). Read it before Phase 1.
`figma-cli` below is the resolved CLI (see the figma-make skill for finding it
and its port); `CLI_SRC` is the `src` folder next to the `src/index.js` it runs.

## What to ask for, and what to remember

- Ask the person to **paste the kit's Make link** (`https://www.figma.com/make/<key>/…`)
  or the bare key. Derive the key yourself; every `--file` takes either form.
- Do **not** ask for anything readable from what you have. The workspace repo,
  library path, guide folder, exclusions and base commit are in the latest
  release's `VENDOR.json`; the release site is built into the CLI; the debug port
  comes from `figma-cli connection`.
- You may remember the kit link for this person **locally** (your own memory, or
  a private file outside every repository such as `~/.figma-cli/atomicaui-skills.json`).
  Confirm it at the start of each run. Never write it, or any key, file name,
  receipt, token or private path, into a repository, a pull request or a shared file.
- Keep every working file (baselines, candidates, plans, receipts, backups) in one
  new private working folder `WORK` outside any repository.

## Hard rules

- **One writer on the kit.** Ask the person to make sure nobody else edits the
  kit during the run. Run one figma-cli command on the kit at a time. `make status`,
  `drift`, `sync`, `release` and `verify-release` take 2–4 minutes on the kit: run
  them as tracked background jobs and wait for each before the next.
  `--timeout` is at most `120000`.
- **Publishing is the person's click.** Never try to Unpublish, Publish, change
  sharing, run Make AI prompts, or press Update kit / Publish kit.
- No Make writes except the commands named below. No hand-written calls into
  Make, no computer-use or mouse automation.
- Never edit the workspace repo, and never hand-edit generated token files anywhere.
- Never fetch or reset someone else's shared clone; read GitHub live (`gh`) and
  use your own fresh clone in `WORK`.

## Hard stops (stop, report in plain words, ask)

| Stop | When |
|---|---|
| **Token gate** | Any added, changed or deleted file under the library's `tokens/generated/` or `tokens/generated.manifest.json`. Tokens only arrive through a reviewed Core token sync in the workspace. The helper refuses with `KIT_TOKEN_GATE`. Hand-written files elsewhere under `tokens/` are component styling: show them and ask, and stop if they add raw colour or size values instead of existing variables. |
| **Baseline mismatch** | The base workspace tree does not reproduce the release's `VENDOR.json` (`KIT_BASE_DIFFERS`), or the latest release is not what the kit holds. |
| **Drift** | `make drift` against the baseline is not `ok`: any mismatched, missing or extra library file, or a different `VENDOR.json` in the kit. Someone edited the kit library (or updated it without a release). Never overwrite it: reconcile through `make export-delta` and the workspace first. |
| **Pending set** | `make status` shows pending changes before you start, or, before any save, pending paths that are not exactly the set you wrote. A Make save takes every pending path. |
| **Timeout or uncertain outcome** | A write, save, sync or release timed out or says its outcome is uncertain. **Read back, never replay** (see Recovery). |
| **`text/html` answer** | The hosted check gets HTTP 200 with `text/html`: the version is not on the site (the site's fallback page), so "200" proves nothing. The CLI client refuses it; do not work around it. |
| **Guide proof** | A guide that will change does not replay byte for byte from its source, does not match its recorded hash, or carries a hand-written note the transform cannot reproduce. |
| **New package** | Changed library files import a package the kit's `package.json` does not declare; `release` would refuse. Adding it is a kit change the person approves first. |
| **Removed guide or library file** | Ask; deletions are rare and need the person's yes. |
| **Not the kit** | The file is in team mode, or a write refuses with `MAKE_VENDOR_LOCKED`: that file installed AtomicAUI from a release, so it is an app, not the kit. Ask for the kit's link. |

## Phase 1: what changed (read-only)

1. `figma-cli connection` and `figma-cli make list`: exactly one open page for the
   kit key. If the debug connection is down, the person relaunches Figma Desktop
   with the debug port (the figma-make skill has the steps); never patch or restart
   it yourself without their go.
2. Read the latest hosted release with the CLI's client and save its `VENDOR.json`
   as the trusted baseline `WORK/base/VENDOR.json` (recipe "Hosted release").
3. From the baseline read `source.repository`, `source.path`, `source.commit`
   (BASE), `exclusions` and the guide folder named at the start of `guidance.source`.
   Check access: `gh api repos/OWNER/REPO --jq .full_name`.
4. Find live main: `gh api repos/OWNER/REPO/commits/main --jq .sha` (NEW). Make a
   private partial clone in `WORK` and check its `origin/main` equals NEW, and BASE
   is an ancestor of NEW (recipe "Workspace trees").
5. Extract the library and guide folders at BASE and NEW, and the package name
   from the library's `package.json`.
6. Build the library candidate `VENDOR.json` with the helper's `vendor` command.
   It proves BASE reproduces the baseline, applies the exclusions, enforces the
   **token gate**, and lists added / changed / removed files and the inventory
   digest. If nothing changed in the library or its guides, stop: nothing to release.
7. List changed guides: `git -C WORK/ws diff --name-status BASE NEW -- <guide folder>`
   (ignore `_template.md`). List the commits and pull requests behind the change
   (`git log --oneline BASE..NEW -- <paths>`, `gh api repos/OWNER/REPO/commits/<sha>/pulls`).
8. Check new package imports in changed files against the kit's `package.json`
   (`figma-cli make read package.json --file KEY --remote --timeout 90000`).
9. **Ask the person** with a plain summary (components, files, guides, pull requests):
   the version (default next patch; their call), whether anything breaks apps
   (then a breaking-notes file, see `make atomicaui release --help`), and the scope.

## Phase 2: kit pre-flight and backup (read-only on the kit)

1. `figma-cli make status --file KEY --json`: git mode, **solo** (a kit has no team
   marker), `pendingCount` 0. Record `savedVersion`: the rollback point.
2. `figma-cli make drift --file KEY --manifest WORK/base/VENDOR.json --json`:
   `ok`, every file matched, `extra` 0, `VENDOR.json` in Make equal to the baseline.
3. Back up every guide that will change: `figma-cli make read guidelines/components/<g>.md
   --file KEY --remote --timeout 90000 --out WORK/kit-guides/<g>.md`. One failed read
   is usually transient: read again before concluding anything.
4. Prove the guide transform on exactly those guides with the helper's `check`
   (recipe "Guides"): every backed-up guide `matched` at the commit its header names
   and `recorded.matched`. A guide made from an older commit is listed under
   `otherCommit`: extract that commit's guide folder and check again.

## Phase 3: candidates (offline)

1. Transform the added and changed guides at NEW with the helper's `transform`.
2. Prepare the sync (preferred path, recipe "Sync"): the workspace package for NEW,
   the candidate folder at full Make paths with the library candidate `VENDOR.json`,
   and the request JSON.
3. Only when the sync path cannot be used (no workspace package tool, or the CLI
   refuses the package), fall back to file-by-file writes (recipe "Fallback"); tell
   the person which path you are using and why.

## Phase 4: write and save

Sync path:
1. Dry run: `make sync … --plan-out WORK/plan.json`. Check `unresolved` and
   `outOfScopeDrift` are empty, `generationManifest` is the bound reference or `null`
   (unbound, component-only), the actions are exactly the changed files, and the plan
   file's `vendorAfter.sha256` equals your candidate `VENDOR.json`'s SHA-256 (otherwise
   the candidate was not adopted: stop). Show the person; apply only on their yes.
2. Apply: `make sync … --apply WORK/plan.json --receipt-out WORK/sync-receipt.json
   --backup-dir WORK/backup`. It saves one version and writes the next trusted
   baseline beside the receipt (`afterManifestPath`).
3. Guides ride a separate write and save (a sync cannot carry `guidance` changes):
   build the final `VENDOR.json` from the after-manifest with the helper's
   `vendor --guides`, write each guide and then `VENDOR.json` last, and save exactly
   those paths with `make save-version` (recipe "Guides write").

Fallback path: one `make write` per file with `--expected-sha256` for every
existing file, `VENDOR.json` last, then one `make save-version` naming every path.

## Phase 5: verify the saved library

1. `make drift --file KEY --manifest <final VENDOR.json> --json`: `ok`, matched =
   the candidate's file count, pending 0.
2. Reload only the kit tab (recipe "Reload") and run the same drift again:
   identical result = the saved state persists, not just this session.
3. `make preview --file KEY --timeout 90000`: no error overlay (the person opens
   one Browser tab in the kit if there is none). Do not edit the kit's own app or
   workbench pages unless the person asks.

## Phase 6: release

1. `figma-cli make atomicaui release --file KEY --version X.Y.Z [--breaking-notes FILE]`.
   It needs a clean saved version, snapshots the saved library into
   `public/atomicaui/X.Y.Z/`, moves `latest.json` (unless it is a backport) and
   saves one version. Folders are immutable: an existing version needs a new number.
2. `figma-cli make atomicaui verify-release --file KEY --version X.Y.Z`: the saved
   folder and hashes match and `latest` is true (for a non-backport). Keep its
   `manifestSha256`.

## Phase 7: the person's click (stop)

Tell the person exactly this, then wait for their word:

> Open the kit in Figma Make → **Make settings → General**. If the site is
> already **Published**, click **Unpublish**, then **Publish**. Set **Who can view**
> to **Anyone on the web**, no password, and keep the same address. The address may
> show 404 for about a minute. **Update kit** and **Publish kit** do not rebuild the site.

## Phase 8: hosted check (read-only)

Replay the release with the CLI's client (recipe "Hosted release"): `latest.json`
names X.Y.Z with the `manifestSha256` from verify-release, and the download checks
every part and file. Also download the previous version: older folders must still
be there. A `text/html` refusal right after publishing: wait a minute and try once
more; still refused, stop and ask the person to check the Publish settings.

## Phase 9: two-way proof

1. Workspace → kit: the Phase 5 drift matched every file of the final `VENDOR.json`,
   whose file list the helper built from workspace NEW, so the kit library equals
   NEW's vendorable files (same inventory digest).
2. Kit → workspace: `make export-delta --file KEY --manifest <final VENDOR.json>
   --who <person> --candidate-dir WORK/ws-full --out WORK/delta.json` must refuse with
   **"No exportable saved changes in scope."** That refusal means clean. Release
   files under `public/atomicaui/` never appear in drift or export.

## Recovery: read back, never replay

| What happened | Do |
|---|---|
| `make write` still says the outcome is uncertain (it already reads back once itself) | `make read <path> --remote --timeout 90000`; SHA-256 equal to the target → run the same write with `--expected-sha256 <target>` (expect `changed: false`) and continue; anything else → stop |
| `make save-version` outcome uncertain | `make status --json`: a new saved version with pending 0 and the expected files → continue; otherwise stop. Never save again blindly |
| `make sync --apply` failed with a recovery receipt | Run the drift the message names; report and stop. Never apply the same plan again |
| `release` timed out | `make status --json`: pending 0 and no new folder → a clean rerun is safe; only that version's folder pending → `--resume --version X.Y.Z`; anything else → stop |
| A command times out before doing anything | Check `make status` first; then retry once with `--timeout 120000` |

## Finish

Report in plain words: the version, the kit versions saved, the rollback point
(the saved version from Phase 2), the `manifestSha256`, what was checked and what
was not (and why). Then point prototypes at the `atomicaui-upgrade-prototype` skill.
