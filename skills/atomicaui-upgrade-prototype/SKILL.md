---
name: atomicaui-upgrade-prototype
description: Upgrade a team-mode Figma Make prototype to a new AtomicAUI release. Runs make atomicaui upgrade in the prototype's local clone, which opens a pull request with the release's files, dependencies and fixes; stops for people to review and merge it; and only after the person says it is merged, deploys main into the Make file with the guarded make deploy (dry run, their yes, apply, verify). Use when someone says "upgrade AtomicAUI in this prototype", "move this prototype to AtomicAUI X.Y.Z", "is this prototype on the latest AtomicAUI" or "deploy the AtomicAUI upgrade". Never merges a pull request.
---

# Upgrade a prototype to a new AtomicAUI

A team-mode prototype keeps its source in a GitHub repo; GitHub `main` is the
source of truth and reaches the Make file only through `make deploy`. AtomicAUI
lives in the prototype under `src/vendor/atomic-aui/`, installed from a hosted
release and recorded in that folder's `VENDOR.json` (`atomicauiRelease`).
New releases come from the `atomicaui-release` skill.

`figma-cli` below is the resolved CLI (see the figma-make skill for finding it
and its port). Git work goes only through `figma-cli team …` and the commands
below (see the figma-make-team skill); never run git or gh writes yourself.

## What to ask for, and what to remember

- The prototype's **local clone** (a folder made by `figma-cli make clone`). If
  there is none, ask for the GitHub repo (`OWNER/REPO`) and clone it with
  `figma-cli make clone OWNER/REPO <folder>`.
- The prototype's **Make link** (`https://www.figma.com/make/<key>/…`) or bare key,
  needed only for the deploy. First look for it yourself: the clone's
  `.figma-cli/project.json` names `fileKey` when the team marker is committed.
  Ask only if it is not there.
- The version: the latest release unless the person names one.
- You may remember the clone folder and Make link for this person **locally**
  (your own memory, or a private file outside every repository such as
  `~/.figma-cli/atomicaui-skills.json`), and confirm them on each run. Never write
  keys, file names, receipts, tokens or private paths into a repo, a pull request or
  a shared file.

## Hard rules

- **Only `make atomicaui upgrade` writes `src/vendor/atomic-aui/`.** Never edit,
  format, move or delete files there, never resolve a conflict in it by hand, and
  never copy library files in from anywhere else. Commits and deploys refuse while
  that folder differs from its `VENDOR.json` (`TEAM_VENDOR_EDITED`,
  `DEPLOY_VENDOR_EDITED`); the fix is always an upgrade, never a hand edit.
- **Never merge.** Not with `team merge`, not with `gh`, not on GitHub, and not
  "merge it anyway". The person and their reviewers merge. You wait for their word.
- **Deploy only on the person's word**, after the merge, and only through
  `make deploy`: dry run, show it, their yes, apply, verify. Never use
  `--override-make` or `--delete-make-only` from this skill.
- This skill is for team-mode prototypes. A solo Make file (no repo) upgrades with
  `figma-cli make atomicaui upgrade --file KEY` through the figma-make skill.

## Hard stops (stop, explain in plain words, ask)

| Stop | When |
|---|---|
| **Local library edits** | `status` lists `localEdits`, or the upgrade refuses with local AtomicAUI edits. Someone changed the library by hand; those changes go back as installed (through a reviewed pull request) or into the library itself, never into the upgrade. |
| **Release not on the site** | The download is refused with HTTP 200 `text/html` (or 404): the release is not published yet. The kit owner still has to Unpublish/Publish the kit site. Do not retry from anywhere else. |
| **Unsaved or foreign work** | The clone has unsaved changes outside the library, or the upgrade branch has work it did not make. Save or set it aside through the figma-make-team skill first. |
| **Major dependency change or breaking notes** | The result lists breaking changes or dependency changes the person did not expect. Show them; they decide. |
| **Deploy refusal** | Any `DEPLOY_*` code. Explain it (figma-make-team skill table) and stop; never work around it. |
| **Uncertain deploy save** | `DEPLOY_SAVE_UNCERTAIN`: only `--verify <receipt>`; never deploy again before verify answers. |

## 1. Check

Run in the clone (or pass `--dir <clone>`):

```sh
figma-cli make atomicaui status --dir <clone>
figma-cli team status --dir <clone>
```

Tell the person the installed version, the latest version, and whether the
library has local edits. Up to date: stop, nothing to do.

## 2. Upgrade (opens the pull request)

```sh
figma-cli make atomicaui upgrade --dir <clone>            # latest
figma-cli make atomicaui upgrade --dir <clone> --to X.Y.Z # a named version
```

It downloads and verifies the release over HTTPS, starts (or continues) its own
task branch from the latest `main`, replaces `src/vendor/atomic-aui/`, merges the
library's dependencies into `package.json`, applies the release's breaking-change
fixes and provider wiring, installs, saves, opens a pull request, and prepares a
review copy with the app built (`review`, and `listen` when a Lavish page opened).

- Tell the person: the pull request link (full `https://` URL), the summary
  (files added/changed/removed, dependencies, breaking changes) and any `notes`.
- When the result has `listen`, start every command in `listen.commands` at once
  as a tracked background job and keep it running, as the figma-make-team skill's
  "Always listening" rule says; turn their notes into `team comment` calls.
- `--to` a lower version is labelled a downgrade; say so.
- Run the command again to continue the same branch after an interruption or when
  `main` moved; `figma-cli team sync` also brings in a newer `main`.

## 3. Stop for review and merge

Say plainly: a teammate reviews and approves the pull request, and the person
merges it (for example by saying "merge it" through the figma-make-team skill, or
on GitHub). This skill does not merge. Wait until the person says it is merged.

## 4. Deploy (only on the person's word, repo admins only)

1. Ask the person to make sure nobody else is editing the prototype's Make file
   during the deploy, and that the file is open in Figma Desktop with the debug
   connection (`figma-cli make list` shows it).
2. Be on an up-to-date `main`: after a merge through `team merge` the clone is back
   on `main`; run `figma-cli make pull <clone>`. If the clone is still on the
   task branch (merged on GitHub), make a fresh clone for the deploy instead:
   `figma-cli make clone --file KEY <new folder>` (or `make clone OWNER/REPO <new folder>`).
3. Dry run, show the person the `summary` and files, keep `planPath`:
   `figma-cli make deploy --file KEY --dir <clone>`. If it lists more than the
   upgrade (other merged work on `main`), say so: a deploy always brings all of `main`.
4. On their yes: `figma-cli make deploy --file KEY --dir <clone> --apply <planPath>`.
   A first deploy (every entry file new to Make) saves two versions, `deploy <sha7> (batch 1)` then
   `deploy <sha7>` with the entry files; an app already in Make saves one. It tags `make-deploy/<n>`;
   keep `receiptPath`.
5. Verify after a fresh reload: `figma-cli make deploy --file KEY --dir <clone> --verify <receiptPath>`
   must report `fresh-sandbox-verified` in its verification.
6. Ask everyone who has the Make file open to reload it.

Interrupted: `DEPLOY_WRITE_FAILED` → ask, then `--resume <receipt>` or `--abort
<receipt>` (never both). `DEPLOY_NOT_ADMIN` → only a repo admin deploys; name who.
`DEPLOY_MAKE_AHEAD` → someone edited Make directly; stop and hand over to the
figma-make-team skill.

## Finish

Report in plain words: the version now on `main` and in Make, the pull request
link, the deploy's saved version and tag, and anything not done (and why).
