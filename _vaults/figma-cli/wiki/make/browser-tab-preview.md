---
title: Make Browser tab and preview reading
description: How make preview picks the Browser workspace tab without its title, and how it finds and reads the preview frame.
date: 2026-10-24
---

# Make Browser tab and preview reading

`make preview` (`src/make-client.js:401`) selects the Browser workspace tab, waits, then reads the preview page inside its own frame. The Files-tab side of the same nav is in [files-tab-resolution.md](files-tab-resolution.md).

## Picking the Browser tab

- Make retitles the Browser tab with the previewed page's `<title>` (for example `LMA · Local Prototype`), as Files tabs take filenames, so its label is never an identity (observed live on 2026-10-24).
- Every workspace tab button in `nav[aria-label="Editor views"]` carries `data-workspace-tab="true"`; only a Files tab has a close control (`data-workspace-tab-close`, aria-label `Close Files tab`). The Browser tab has none, and nothing (no `aria-controls`) links a tab to the preview iframe (observed live on 2026-10-24).
- The Browser tab is therefore the one visible workspace tab that is not a Files tab (`src/make-workspace.js:41`). None or more than one refuses with the count found; no tab is opened, closed, or added.
- The legacy Code/Preview radio layout uses the Preview radio instead (`src/make-workspace.js:14`).

## Finding and reading the preview frame

- The preview iframe must be `https:` on one of two hosts (`src/make-client.js:23`): the live session proxy `*.makeproxy-<x>.figma.site`, or the Browser tab's cached preview `<id>-figmacachedpreview.figma.site` (seen live on 2026-10-24).
- The cached preview's iframe `src` carries a one-time `__figma_cached_preview_token` query, and the app then routes elsewhere (for example `/app/pages/lma-projects-table`), so the isolated CDP target never has the `src` URL. The target is matched by origin, which is unique per preview, and exactly one match is required (`src/make-client.js:429`).
- The reported `url` is origin plus path only, so the token never appears in output (`src/make-client.js:436`).

Tests: `tests/make-client.test.js:473`, `tests/make-client.test.js:484`, `tests/make-client.test.js:497`, `tests/make-client.test.js:512`.
