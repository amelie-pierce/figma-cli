---
title: Read-only Make vendor drift
description: Complete hidden-file inventory and manifest comparison for a saved git-mode Make file.
date: 2026-10-13
---

# Read-only Make vendor drift

`make drift` takes an exact Make file key and VENDOR.json bytes. It validates relative manifest paths, byte counts, SHA-256 values and duplicates before comparing (`src/commands/make.js:134`, `src/make-drift.js:16`). The default root is `src/vendor/atomic-aui`; VENDOR.json is separate metadata whose Make copy must match the supplied bytes (`src/make-drift.js:68`). An external receipt can pin the file key, manifest SHA-256 and full saved git SHA (`src/make-drift.js:41`).

The DOM-only Make file tree cannot establish hidden entries (`src/make-tree.js:1`). Drift instead recursively uses read-only `fs/dir/list` with `includeHidden: true`, then `fs/file/read` for every file. It hashes raw bytes, so text decoding and newline normalization cannot conceal a difference (`src/make-client.js:445`, `src/make-client.js:454`, `src/make-client.js:472`). The bridge only accepts an exact `code/` path on the selected Make page (`src/make-rpc.js:107`). Missing and extra files are counted; a mismatch, incomplete listing or uncertain saving state exits nonzero (`src/make-drift.js:54`, `src/commands/make.js:154`).

The inventory is a working-copy read. `make drift` brackets it with Make's own mode, baseline and pending-state snapshot, then fails if that state changes (`src/make-client.js:441`, `src/make-client.js:481`, `src/make-drift.js:75`). The React-state scan keeps fixed limits: array items past 30 and values deeper than 3 levels are skipped and counted in `scanTruncation` (`arrayItems`, `depth`); exhausting the object, fiber or hook budget, or finding `codeFileChanges` snapshots that disagree, leaves persistence unverified (`src/make-persistence.js:1`). It does not mutate source, save a version or prove fresh-sandbox reprovision. The mode-specific boundary is in [persistence.md](persistence.md).
