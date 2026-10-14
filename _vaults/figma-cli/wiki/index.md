---
title: figma-cli knowledge vault
description: Entry point and constitution for compiled, file-cited knowledge about figma-cli.
date: 2026-10-13
---

# figma-cli knowledge vault

figma-cli controls Figma Desktop over the Chrome DevTools Protocol (CDP), with no API key.
This fork adds `make` commands for Figma Make source. Saving modes and inventory checks are described in [make/persistence.md](make/persistence.md) and [make/drift.md](make/drift.md); explicit library exchange is in [make/sync.md](make/sync.md); project status and solo/team mode are in [make/status.md](make/status.md); switching modes is in [make/mode.md](make/mode.md); running a team-mode project locally is in [make/local.md](make/local.md); the designer git layer (`figma-cli team`) is in [make/team.md](make/team.md); cross-review between designers is in [make/review.md](make/review.md); deploying `main` into Make is in [make/deploy.md](make/deploy.md).
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
| [make/](make/index.md) | Figma Make: page discovery, source access, saving modes and vendor drift checks |
| [testing/](testing/index.md) | Test layout, suites and fixtures |

## Note conventions

- Frontmatter: `title`, `description`, `date`.
- Link notes with relative Markdown links; a link to a note not yet written marks a gap.
- Every claim cites `path:line`. Line numbers drift; re-check against live code before relying on one.
- A fact not verified in code is marked `UNVERIFIED`.
