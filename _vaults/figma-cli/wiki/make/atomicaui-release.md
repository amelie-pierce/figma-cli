---
title: AtomicAUI kit-hosted releases
description: Immutable site payloads and the boundary with vendor exchange.
date: 2026-10-16
---

# AtomicAUI kit-hosted releases

`make atomicaui release` builds a versioned payload under
`public/atomicaui/<version>/` and moves `public/atomicaui/latest.json` after
writing the full payload. New releases contain only bounded archive base64
parts, `manifest.json`, `manifest.sha256`, and the latest pointer. The manifest
records hashes and sizes for every source file and decoded archive
parts (`src/make-atomicaui.js:113`, `src/commands/make-atomicaui.js:32`). The
save requires the exact release path set, and `verify-release` replays the
client download chain over the saved Make files: the release's own sidecar,
manifest, parts and archive plus the exact folder path set; `latest.json` is
checked only when it names that version (`src/commands/make-atomicaui.js`). After saving, the manual site rebuild is
**Make settings → General → Unpublish → Publish** (skip Unpublish when the site
is not already published). Set **Who can view** to **Anyone on the web**, no
password, and keep the address. The address can return 404 for about a minute
during republishing. **Update kit** and **Publish kit** do not rebuild the site.
The first saved release contained 265 source files in 270 release paths. The
archive-only layout keeps those bytes in the verified archive with a handful
of Make writes; the downloader still accepts the first release's direct paths.

An interrupted solo `add` or `upgrade` can resume with the exact `--file`,
version and `--resume`. `VENDOR.json` is written last; pending vendor files
must equal the release, pending fix targets must round-trip through the
planned fixes, and pending wiring must equal the planned wiring before the
single save (`src/commands/make-atomicaui.js`).
Deep vendor paths may exceed the Make file-tree viewport, which prevents the
editor selector from proving their ancestry (`src/make-tree.js:342`). For this
selection refusal or a selected vendor path with no source editor, solo
installation and workspace sync accept agreement among
the client VFS, sandbox, and rendered tree for paths under
`src/vendor/atomic-aui/`; other editor failures still stop the write
(`src/make-client.js:498-566`, `tests/make-durable.test.js`).

`public/atomicaui/**` is kit-only data. Vendor drift, workspace-to-Make sync,
and Make-to-workspace export deltas exclude those paths
(`src/make-drift.js:4`, `src/make-sync.js:152`, `src/make-sync.js:268`). Older
kits without `tokens/generated.manifest.json` can verify an unchanged
generated tree against the supplied committed package manifest during a
read-only component sync plan (`src/make-sync.js:175`). Tests for the release
transport, interrupted resume, and sync boundary are in
`tests/make-atomicaui.test.js`, `tests/make-drift.test.js`, and
`tests/make-sync.test.js`.
