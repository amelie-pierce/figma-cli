---
title: Read-only Make vendor drift
description: Complete hidden-file inventory and manifest comparison for a saved git-mode Make file.
date: 2026-10-13
---

# Read-only Make vendor drift

Updated 2026-10-13: saving-mode detection now reads direct provider props, so large unrelated React state no longer hides a live mode (`src/make-persistence.js:21`, `src/make-persistence.js:51`).

`make drift` takes an exact Make file key and VENDOR.json bytes. It validates relative manifest paths, byte counts, SHA-256 values and duplicates (`src/commands/make.js:134`, `src/make-drift.js:16`). The default root is `src/vendor/atomic-aui`; VENDOR.json is separate metadata whose Make copy must match the supplied bytes (`src/make-drift.js:68`). An external receipt can pin the file key, manifest SHA-256 and full saved git SHA (`src/make-drift.js:41`).

The DOM-only tree cannot establish hidden entries (`src/make-tree.js:1`). Drift recursively lists the root through read-only `fs/dir/list` with `includeHidden: true`, then reads each file as raw bytes (`src/make-client.js:583`). It reports missing and extra files, and fails on mismatch, incomplete listing or uncertain saved state (`src/make-drift.js:54`, `src/commands/make.js:155`).

The inventory is a working-copy read. `make drift` brackets it with Make's mode, baseline and pending-state snapshots, then fails if that state changes (`src/make-client.js:583`, `src/make-drift.js:75`). It does not mutate source, save a version or prove fresh-sandbox reprovision. See [persistence.md](persistence.md).
