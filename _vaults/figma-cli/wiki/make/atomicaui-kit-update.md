---
title: AtomicAUI kit update helpers and skills
description: The offline guide transform, guide replay check and candidate VENDOR.json builder, and how the release and upgrade skills use them.
date: 2026-11-04
---

# AtomicAUI kit update helpers and skills

A kit update moves workspace AtomicAUI source and its component-class docs into
the kit; a release then snapshots the saved kit ([atomicaui-release.md](atomicaui-release.md)).
The skills `skills/atomicaui-release/` and `skills/atomicaui-upgrade-prototype/`
run that flow and the downstream team upgrade; their offline steps are
`src/make-atomicaui-kit.js`, a module that is also a Node script (`run`,
`src/make-atomicaui-kit.js:322`; the script guard at `src/make-atomicaui-kit.js:390`).
It reads local folders only. Tests: `tests/make-atomicaui-kit.test.js`.

## Guide transform

Kit guides `guidelines/components/<g>.md` were produced by hand-run scripts that
were lost once; the transform is now `transformGuide` (`src/make-atomicaui-kit.js:48`):
the workspace package specifier (passed in, read from the library's
`package.json`) becomes `@/vendor/atomic-aui`, its `index.css` becomes
`src/vendor/atomic-aui/tokens/index.scss`, `Core 6.0` becomes `Core 7.0`, and a
6-line provenance header naming the doc and the 12-character source commit goes
after the frontmatter or else after the H1, skipping one blank line. CR line
endings are refused. `guideSource` reads the header back
(`src/make-atomicaui-kit.js:76`), so `checkGuides` replays only kit guides made
from the given commit and lists the rest under `otherCommit`
(`src/make-atomicaui-kit.js:115`). Given the guide folder at each guide's own
header commit C (`originDirs`, `--origin C=DIR`), it compares the doc at C with the
doc at this commit (`body`: `same`, `changed`, `annotated`, `noSource`,
`needsOrigin`): `regenerate` is the `changed` ones (the kit copy replays from C)
plus `notInKit`, and `annotated` is a changed doc whose kit guide has a
hand-written note, which the release stops on rather than overwrite. An unchanged
doc leaves its guide alone, note or not. The release selects guides this way at
NEW instead of by `git diff BASE NEW`.

Proof on the 7.0.2 data (2026-11-04, local, not committed): replaying the 47
guides from their source commit reproduced 44 recorded hashes; the 3 others carry
hand-written verification notes the transform cannot reproduce (VENDOR.json
`guidance.transform` names them). The 4 guides changed in 7.0.2 reproduced
byte for byte. Guide entries can come from different commits: a guide whose
workspace doc changed after its own commit C is stale. The next release's check at
NEW puts it in `regenerate` when its kit copy replays from C, or in `annotated`
(stop and report) when it carries a hand-written note.

## Candidate VENDOR.json and the token gate

`candidateVendor` (`src/make-atomicaui-kit.js:230`) inventories the base and new
workspace library under the baseline's `exclusions` (anchored globs, `**/` also
matching the root: `globRegExp`, `src/make-atomicaui-kit.js:171`). The base tree
must reproduce the baseline `files` exactly (`KIT_BASE_DIFFERS`,
`src/make-atomicaui-kit.js:249`), which also catches any other reading of the
exclusions. Any change under `tokens/generated/` or to
`tokens/generated.manifest.json` refuses (`KIT_TOKEN_GATE`,
`src/make-atomicaui-kit.js:263`); hand-written token-folder styling passes and is
reported. Only `source.commit`, `source.commitDate`, `files` and `guidance.files`
change; `mergeEntries` keeps the existing order (the kit's list is not strictly
sorted: `tokens/generated/_index.scss` precedes `.generated`) and inserts new
entries before the first greater path (`src/make-atomicaui-kit.js:214`). The
baseline must round-trip as 2-space JSON with a trailing newline.
On the 7.0.2 data it rebuilt the saved 7.0.2 `VENDOR.json` byte for byte.

Why the candidate matters for `make sync`: without a candidate `VENDOR.json`
pinned to the request's commit and listing exactly the reviewed inventory, the
plan keeps the baseline's `source` and only rewrites `files`
(`src/make-sync.js:258`), so the saved kit would name the old commit. The skill
checks the plan's `vendorAfter.sha256` equals the helper's `sha256`; a test
drives `planSync` with the helper's candidate folder to prove adoption
(`tests/make-atomicaui-kit.test.js`, last test). Guide hashes still need their own
write and save after a sync (see [sync.md](sync.md)).

## Downstream upgrade

`make atomicaui upgrade --dir` does the branch, save, pull request and review copy
itself (`installTeamRelease`, `src/commands/make-atomicaui.js:315`); the skill only
adds the stop for people to merge and the guarded `make deploy`
([deploy.md](deploy.md)). `make pull` fast-forwards `main` without switching
branches (`src/make-local.js:302`), so after a merge on GitHub the skill deploys
from a fresh `make clone` rather than switching the clone with git.
