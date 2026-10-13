---
title: figma-cli knowledge vault
description: Entry point and constitution for compiled, file-cited knowledge about figma-cli.
date: 2026-10-13
---

# figma-cli knowledge vault

figma-cli controls Figma Desktop over the Chrome DevTools Protocol (CDP), with no API key.
This fork adds `make` commands that read and edit Figma Make source through the Make editor UI.
Source lives in `src/` (CLI entry `src/index.js`, Make code in `src/make-*.js` and `src/commands/make.js`); tests live in `tests/`.

## Operating mode

Notes are compiled just in time: when a task needs a piece of knowledge, read the live code, then write or update one focused, file-cited note.
Update an existing note rather than writing a parallel one, and mark the change `Updated YYYY-MM-DD`.
Every note is registered in its folder `index.md` in the same change.
Wiki notes never link into `raw/`, which is untracked.

## Authority order

When sources disagree: live code (`src/`, `tests/`) wins, then the repository docs (`AGENTS.md`, `REFERENCE.md`, `skills/figma-make/SKILL.md`), then these wiki notes, then session memory.
Volatile detail such as selectors, error strings and option names stays by pointer to the source file, not copied here.

## Taxonomy

| Folder | Holds |
|---|---|
| [make/](make/index.md) | Figma Make: CDP page discovery, workspace and Files-tab resolution, file selection limits and the filesystem bridge |
| [testing/](testing/index.md) | Test layout, suites and fixtures |

## Note conventions

- Frontmatter: `title`, `description`, `date`.
- Link notes with relative Markdown links; a link to a note not yet written marks a gap.
- Every claim cites `path:line`. Line numbers drift; re-check against live code before relying on one.
- A fact not verified in code is marked `UNVERIFIED`.
