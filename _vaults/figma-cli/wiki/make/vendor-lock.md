---
title: Release-installed AtomicAUI vendor lock
description: Why direct writes, team commits and deploys refuse edits under a release-installed src/vendor/atomic-aui, and which commands may still write it.
date: 2026-11-03
---

# Release-installed AtomicAUI vendor lock

An app that installed AtomicAUI with `make atomicaui add`/`upgrade` records the
release in `src/vendor/atomic-aui/VENDOR.json` as `atomicauiRelease`. Every
upgrade replaces that folder, so a direct edit there is lost on the next one.
The lock keys on that record (`installedRelease`, `src/make-vendor-lock.js:23`):

- Make verbs `write`, `delete`, `replace`, `create`, `import`, `remove` read
  Make's own VENDOR.json through the client VFS and refuse any path in the
  folder with `MAKE_VENDOR_LOCKED` before writing; an unreadable VENDOR.json
  also refuses (`src/make-vendor-lock.js:36`, call sites `src/commands/make.js:134`,
  `src/commands/make.js:247`).
- Team commits go through `commitLocal`, so `team save`, `sync`, `pr` and
  `start --save-first` refuse with `TEAM_VENDOR_EDITED` while the clone's files
  differ from the VENDOR.json file records (`src/make-team.js:496`).
- `make deploy` plan and apply refuse with `DEPLOY_VENDOR_EDITED` before reading
  Make (`src/make-deploy.js:680`, `src/make-deploy.js:1028`).

Not locked: the AtomicAUI `release`, `add`/`upgrade` and `sync` commands, which
call the client's internal writers; the kit that authors AtomicAUI, whose
VENDOR.json vendors workspace source and records no release (so no escape flag
exists); and any project without that VENDOR.json. The upgrade's own team save
passes because the installed folder equals the new VENDOR.json.

`localFiles` and `vendorEdits` moved here from `src/make-atomicaui.js`, which
re-exports `vendorEdits`. Tests: `tests/make-vendor-lock.test.js` (Make, clone
and deploy refusals and allows) and the vendor-lock block at the end of
`tests/make-team.test.js`.
