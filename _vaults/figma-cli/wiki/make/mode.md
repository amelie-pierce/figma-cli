---
title: Make team-mode toggle (make mode team|solo)
description: How make mode adds or removes the team marker as its own saved version, why the save is checked as a tree, the gate exemption's scope, reload verification and receipts.
date: 2026-10-14
---

# Make team-mode toggle

`make mode team` and `make mode solo` (`src/commands/make.js:355`) are the only commands that add or remove `.figma-cli/project.json`, the marker that puts a file in team mode (see [status.md](status.md)). Without them, writing the marker and then saving it is refused by the very gate the marker turns on.

## Gate exemption scope

- `make mode` skips `checkWriteMode` and runs `runModeChange` (`src/make-mode.js:141`), which only ever names the marker: `requireModeTogglePaths` (`src/make-mode.js:24`) refuses any path set other than exactly `[PROJECT_MARKER]` before the save.
- Every other write command refuses the marker path in every mode with `MAKE_MARKER_RESERVED` (`refuseMarkerPaths`, `src/make-project.js:110`), checked in `withClient` before connecting (`src/commands/make.js:65`) and on `import` manifests (`src/commands/make.js:138`). The check folds case and a leading `./`.
- Ordinary paths still meet the full team-mode refusal. Tests: `tests/make-mode.test.js`.

## Why the save is checked as a tree

Make does not list paths under a dot folder such as `.figma-cli/` in `codeFileChanges.changedFiles`: a scratch probe write showed `pendingCount` 0 while the working tree SHA changed (2026-10-14). `save-version`'s exact-pending check cannot see the marker, so `saveCheckedVersion` (`src/make-client.js:692`) generalizes the first-version save:

- base: the saved version's tree, or with `--first-version` the `since` sandbox commit (default: the sandbox head read before the write);
- Make must list nothing pending, and the working copy's difference from the base must equal the expected paths exactly (`requireFirstVersionPending`, `src/make-durable.js:107`);
- `createVersion` is called with an empty expected list, and the saved tree must equal the working tree the check read.

`saveFirstVersion` now delegates to it (`src/make-client.js:681`).

## Plan, refusals and verification

- `planModeChange` (`src/make-mode.js:37`) is pure. It requires the client VFS and sandbox copies of the marker to agree and refuses other listed or unsaved paths, a marker for another file or repo, an unusable marker on `team`, and no-ops. A marker written or removed but never saved is saved rather than refused (on a never-saved file this needs `--since`).
- Marker bytes are `{fileKey, repo, trunk: "main"}` (`src/make-mode.js:19`).
- `solo` warns, then requires `admin` on the marker's repo through `gh` GET requests, failing closed when `gh` cannot read it, and requires `--yes-turn-off-team-mode`. An unusable marker's raw `repo` is still used for the admin check. Saving a removal an earlier run left unsaved takes the repo from the local link that run kept, and refuses without one.
- After the save, `reloadPage` (`src/make-client.js:767`) sends `Page.reload` to that tab only and waits for a new document with Make state. `verifyModeAfterReload` (`src/make-mode.js:120`) then requires a clean baseline at the new version, the planned saved tree, and the marker present (or absent) in the saved tree, sandbox and client VFS.
- Receipts go to `~/.figma-cli/mode-receipts/` (mode 0600, `src/make-mode.js:109`). `team` records the local repo link; `solo` removes it (`forgetLinkedRepo`, `src/make-project.js:80`) so later writes are solo rather than ambiguous.

## Live proof (2026-10-14)

Scratch `2X8cYvemgPmUJSZ5GWaeRB`, repo `amelie-pierce/figma-testing-workflow`:
- `team`: version 8 `e508000f…`, tree `3dd224b9…`, reload-verified. Then a plain `make write` refused with `MAKE_TEAM_MODE`, a marker write refused with `MAKE_MARKER_RESERVED`, a second `team` refused as unchanged, and `solo` without the flag refused with `MAKE_MODE_CONFIRM_REQUIRED`.
- `solo`: version 9 `6c47a073…`, tree back to `58710ecd…` (the pre-toggle tree), reload-verified, local link removed.
- `--first-version` was not re-proven live; no never-saved scratch file remained. It reuses the first-version path proven in [persistence.md](persistence.md) and is covered by unit tests.
