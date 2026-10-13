---
title: Make Files-tab resolution
description: How Make source commands pick, reuse or open a Files workspace tab, and why titles are not used.
date: 2026-10-13
---

# Make Files-tab resolution

Two "tab" meanings exist. A Figma Desktop tab is a CDP page target per project ([cdp-page-discovery.md](cdp-page-discovery.md)). Inside that page, the newer Make layout has workspace tabs in `nav[aria-label="Editor views"]`: one Browser tab plus any number of Files tabs. This note is about the second kind.

## Identifying Files tabs

- A Files tab is the sibling button of a `Close Files tab` control (`src/make-workspace.js:32`). Its visible label becomes the selected filename (for example `Inputs.tsx`), so the label is never an identity.
- The active Files pane is proven by a visible `files-workspace-header` and file tree, not by tab styling (`src/make-workspace.js:48`). The DOM exposes no `aria-selected` on these tabs (observed live with `make ui`, 2026-10-13).

## Resolution order for `ensure-code` (`inspect`, `files`, `read`, writes)

1. Legacy Code/Preview radios: use the Code radio (`src/make-workspace.js:11`).
2. A visible Files pane exists: reuse it; expand a collapsed tree with `Show files` (`src/make-workspace.js:50`).
3. Files tabs exist but none is active (for example Browser is active): click the first Files tab in tab order (`src/make-workspace.js:54`). Every Files tab in the page belongs to the page's project, which the guard has already checked by file key, and all show the same source tree, so the first is a deterministic, safe choice.
4. No Files tab exists: report `needsFilesTab`, and `_ensureCode` opens one through **Add workspace tab → Files**, once per operation (`src/make-workspace.js:45`, `src/make-client.js:263`, `src/make-workspace.js:67`).
5. More than one visible Files pane is ambiguous and stops the operation (`src/make-workspace.js:49`).

`_ensureCode` then polls `inspect` until the tree and header are ready (`src/make-client.js:263`). Operations enable focus emulation so hidden Desktop tabs keep updating their virtualized tree (`src/make-client.js:231`).

## Figma behaviour to expect

Clicking a file in the tree (`src/make-tree.js:210`) makes Figma show it in a Files tab next to the active one; a later selection of another file relabelled that same tab rather than adding more (observed live on 2026-10-13: `Inputs.tsx | model.ts | ToggleControls.d.ts` became `Inputs.tsx | aui.ts | ToggleControls.d.ts`). The CLI does not close tabs.

Tests: `tests/make-client.test.js:209`, `tests/make-client.test.js:222`, `tests/make-client.test.js:234`, `tests/make-client.test.js:246`.
