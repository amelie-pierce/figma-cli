---
title: AtomicAUI kit-hosted releases
description: Immutable site payloads and the boundary with vendor exchange.
date: 2026-10-16
---

# AtomicAUI kit-hosted releases

`make atomicaui release` builds a versioned payload under
`public/atomicaui/<version>/` and moves `public/atomicaui/latest.json` after
writing the full payload, unless the version is older than the current latest
(a backport keeps its folder and leaves the pointer alone). New releases contain only bounded archive base64
parts, `manifest.json`, `manifest.sha256`, and the latest pointer. The manifest
records hashes and sizes for every source file and decoded archive
parts (`src/make-atomicaui.js:160`, `src/commands/make-atomicaui.js:37`). The
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
version and `--resume`. `VENDOR.json` is written last. The saved version's
own files are read from the sandbox git objects (`MakeClient.readSaved`):
the change report uses the saved `VENDOR.json`, pending vendor files must
equal the release, and each pending app file must equal the fixes and wiring
applied to its saved text (and differ from it) before the single save
(`src/commands/make-atomicaui.js`).
Deep vendor paths may exceed the Make file-tree viewport, which prevents the
editor selector from proving their ancestry (`src/make-tree.js:345`). For this
selection refusal or a selected vendor path with no source editor, solo
installation and workspace sync accept agreement among
the client VFS, sandbox, and rendered tree for paths under
`src/vendor/atomic-aui/`; other editor failures still stop the write
(`src/make-client.js:542-612`, `tests/make-durable.test.js`).

`public/atomicaui/**` is kit-only data. Vendor drift, workspace-to-Make sync,
and Make-to-workspace export deltas work on `inventoryVendor('src/vendor/atomic-aui')`,
which lists only that folder, so release assets never reach them
(`tests/make-sync.test.js`, kit release files beside the vendored library). Older
kits without `tokens/generated.manifest.json` can verify an unchanged
generated tree against the supplied committed package manifest during a
read-only component sync plan (`src/make-sync.js:175`). Tests for the release
transport, interrupted resume, and sync boundary are in
`tests/make-atomicaui.test.js`, `tests/make-drift.test.js`, and
`tests/make-sync.test.js`.
