---
title: AtomicAUI kit-hosted releases
description: Immutable site payloads and the boundary with vendor exchange.
date: 2026-10-15
---

# AtomicAUI kit-hosted releases

`make atomicaui release` builds a versioned payload under
`public/atomicaui/<version>/` and moves `public/atomicaui/latest.json` after
writing the full payload. The archive and large sources are split into bounded
base64 parts; the manifest records hashes and sizes for files and decoded
parts (`src/make-atomicaui.js:113`, `src/commands/make-atomicaui.js:32`). The
save requires the exact release path set, and `verify-release` reads every
saved path and hash from the Make filesystem bridge
(`src/commands/make-atomicaui.js`). After saving, the manual site rebuild is
**Make settings → General → Unpublish → Publish** (skip Unpublish when the site
is not already published). Set **Who can view** to **Anyone on the web**, no
password, and keep the address. The address can return 404 for about a minute
during republishing. **Update kit** and **Publish kit** do not rebuild the site.
The first saved release contained 265 source files in 270 release
paths.

`public/atomicaui/**` is kit-only data. Vendor drift, workspace-to-Make sync,
and Make-to-workspace export deltas exclude those paths
(`src/make-drift.js:4`, `src/make-sync.js:152`, `src/make-sync.js:268`). Older
kits without `tokens/generated.manifest.json` can verify an unchanged
generated tree against the supplied committed package manifest during a
read-only component sync plan (`src/make-sync.js:175`). Tests for the release
transport, interrupted resume, and sync boundary are in
`tests/make-atomicaui.test.js`, `tests/make-drift.test.js`, and
`tests/make-sync.test.js`.
