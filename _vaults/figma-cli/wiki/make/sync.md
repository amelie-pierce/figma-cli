---
title: Explicit Make library sync
description: Recorded bidirectional component exchange and Core-bound token distribution.
date: 2026-10-13
---

# Explicit Make library sync

`make export-delta` exports additions, edits and deletions from a clean saved
Make version relative to an external VENDOR.json baseline. Its full vendor
paths are accepted by workspace `atomic-cli intake-make-delta --from`; generated
tokens and sync metadata are excluded (`src/commands/make.js:206`,
`src/make-sync.js:257`). A required `--candidate-dir` of workspace copies marks
every exported file whose workspace copy also differs from the baseline as a
conflict for intake. The workspace path mapping is defined by
`tools/atomic-cli/src/lib/make-kit.ts` at workspace commit
`bf50e2b0465f8908c3069b4ad2127b31a5f6a98d`.

Workspace-to-Make sync consumes the committed generated-tree package format
`atomic-cli/make-kit-package@1`, with exact destination paths, counts and SHA-256.
The package's generation-manifest reference binds a separately supplied
`generated.manifest.json` when tokens change. Component-only sync verifies the
existing full token tree and generated manifest against the package
(`src/make-sync.js:44`, `src/make-sync.js:142`, `src/make-drift.js:91`). Workspace
`tools/atomic-cli/src/lib/generated-manifest.ts` defines its tree digest and
file inventory at the same commit.

Every request names the Make file, engineer, direction, workspace commit, exact
paths, per-file baseline and candidate hashes, dependencies, and conflict
choices. The default dry-run records before/after hashes, compact diffs,
conflicts and a plan digest. Apply reloads and recomputes the entire plan before
durable writes, exact-path save and final drift; unresolved conflicts and
out-of-scope drift refuse
apply (`src/make-sync.js:92`, `src/make-sync.js:142`, `src/make-sync.js:245`,
`src/make-sync.js:294`, `src/commands/make.js:224`). `override-workspace` is a
review handoff, so Make apply waits for a new committed candidate. `make sync`
refuses `make-to-workspace`; Make changes enter through export-delta,
intake-make-delta and a reviewed workspace PR. Apply writes the exact
after-VENDOR.json beside the receipt as the next trusted `--manifest`.

The inventory walks hidden files in 24-call renderer batches and checks saved
version/pending state at each boundary, then validates
`generated.manifest.json` when present (`src/make-client.js:672`,
`src/make-client.js:735`, `src/make-drift.js:91`). A post-save drift match is
working-copy proof; fresh-sandbox reload is still required for persisted-state
proof (`src/commands/make.js:224`, `src/make-client.js:735`).

Tests: `tests/make-sync.test.js` and `tests/make-drift.test.js`.

## Live validation, 2026-10-13

The approved scratch Make file `EtRNzbPHj8k07PiTgqnY7N` saved the two-file
generated package subset from workspace commit
`bf50e2b0465f8908c3069b4ad2127b31a5f6a98d`, with a scratch-only
generated manifest. The first dotfile write was accepted but its old visible-tree
read-back timed out; inspection found exactly one pending `.generated` file with
SHA-256 `710d482a55af46741c7910a82fbd95cd74d7e31c4e0d74cb806561b4796555fa`.
That path was saved as scratch version 9, then a new plan saved the remaining
paths as version 10, git SHA `906b8f4853061cd327d03ec0e627d826bed971a3`.
After an exact-tab reload, drift matched 4 files with no pending changes and
VENDOR.json SHA-256 `38d87c73fdfb5c4fbdee8d78f5b71514967c411684a6aaca203c02ffa5df6cfb`.
The dotfile read-back fix is at `src/make-client.js:479`; its regression test is
in `tests/make-durable.test.js`.

A saved scratch component edit became a one-file delta at version 11, git SHA
`4f2f813a9bc9cd17d453046313727616e48e0d89`, with before/after hashes
`0d86b2700684c78880538f07c305cb0ac9616baaa6130683867346c64fe419ab`
and `1b34317243459c6d27d79984432dad5fd569ac6b87ec47a1a320fe26fab79f4a`.
AtomicAUI 7.0 (`7qXNER6pu1lbTG4fhBQQIv`) was read only: saved SHA
`5a76f4542fb6962659c3beda45f3a753c123f577`, pending 0, 264 matched
files in 15 batches, manifest SHA-256
`04982df46ad85df4c31f87c7a5740ccd8bbd17723c7400626bdbdca4264a6f6c`.
