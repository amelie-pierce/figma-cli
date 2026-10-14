---
title: Make project status, tree SHAs and solo/team mode
description: How make status hashes a Make project as git does, detects solo/team mode, compares with GitHub main, and how the write gate uses the mode.
date: 2026-10-14
---

# Make project status and solo/team mode

`make status` is the read-only base for the GitHub-first collaboration flow: GitHub `main` is the source of truth and Make is a deploy target. The join key between Make and GitHub is the **git tree SHA**, because Make's sandbox commits and GitHub's mirror commits have different SHAs for the same tree.

## Tree SHAs

- **Saved tree.** Read from the saved version's own commit in the sandbox `.git` (`src/make-client.js:839`, reader `src/sandbox-git.js:71`). Loose and packed objects (with deltas) are supported; every object is hash-checked. Without a saved baseline, the sandbox HEAD (loose ref or `packed-refs`) is used.
- **Why not re-hash bytes:** Make commits template files as `100755` and files written or edited later as `100644`, and Push mirrors the modes. Bytes hashed with default modes give a different tree (scratch test T6, 2026-10-14). The bridge listing exposes no mode: its `permissions` field was `4` on a `100755` file.
- **Working tree.** Every file under the project root is re-hashed. A blob equal to the saved tree keeps that mode; anything else takes `100644` (`src/make-project.js:137`). Live, both scratch and Hinge working trees equalled their saved/head trees.
- **Hashing** matches `git hash-object` and `git write-tree`, including git's tree order where a folder sorts as `name/` (`src/git-tree.js:34`, tests `tests/make-git-tree.test.js`).

## Project-root inventory

`inventoryProject` lists the `code` root through the bridge (`src/make-client.js:745`). The bridge allows `code` for `fs/dir/list` only (`src/make-rpc.js:113`).
- The root listing **omits `.git`** even with `includeHidden`, so `.git` is listed directly.
- **Make never answers a listing of a missing folder**; the request times out. The root listing omits `.git`, so its absence cannot be proven: `projectStatus` lists `.git` once and any failed listing fails the status ("Make sandbox git is unavailable", exit 1). Sandbox git folders are listed only after their parent shows them.
- The saved tree is read first; its paths count as tracked. Always excluded and never read: `.git` and `PROJECT_EXCLUDES` (`.npmrc`, `.figma/design-context/`; `src/make-project.js`). The runtime `.git/info/exclude` and each folder's `.gitignore` are applied as git does (`src/git-tree.js`), except that tracked paths are kept (a committed, ignored `dist/` is hashed). An untracked `node_modules/` is skipped. Symbolic links are refused.
- Version and pending state are compared around the git-object read and at every inventory batch boundary.
- LFS paths are left out of every comparison: working vs saved, Make vs main, and the mirror check. Submodule gitlinks (`160000`) hash as git does.

## Mode

The committed marker `.figma-cli/project.json` (`{fileKey, repo, trunk?}`) in Make's working copy decides the mode (`src/make-project.js:29`, `src/make-project.js:81`):

| Mode | When | Writes (all, session-only ones included) |
|---|---|---|
| team | marker names this file | refused, `MAKE_TEAM_MODE` |
| invalid | marker unreadable or names another file | refused, `MAKE_MARKER_INVALID` |
| ambiguous | no marker, a repo from `--repo` or a recorded link | refused unless `--solo` |
| solo | neither | allowed, with a stderr note |

The Make page exposes no readable GitHub link: a read-only prop scan of Hinge found only `enableConnections: true` (2026-10-14). So `make status --repo` records the file key → repo link locally in `~/.figma-cli/make-repos.json` once the repo reads (never in the repo or in Make), and the write gate reads that record when the write has no `--repo`. Without a record or a marker a write is solo and prints a note that team mode is detected only through the marker or a prior `make status --repo`. The gate reads the marker through the client VFS before any write, session-only writes included (`checkWriteMode` in `src/make-project.js`).

## GitHub side

`readGithub` uses the caller's `gh` login with GET requests only (`src/make-project.js:189`):
- `main`'s commit and tree, and the latest `make-deploy/<n>` tag. The base is the `mainTree` of the tag's JSON receipt, or the tagged commit's tree.
- Commits since the base (all history without one, up to 100). Each is checked against `commits/<sha>/pulls` for a merged PR into the trunk.
- The caller's permission from `repos/<repo>` (`admin` may deploy).

`buildStatus` (`src/make-project.js:250`) derives:
- the relation from the saved tree;
- `mirror` from the **working** tree, because Push sends unsaved edits too;
- LFS paths (root `.gitattributes`), compared outside the tree join, since Make stores the pointer and Push the raw bytes (T7).

## Live proof (read-only, 2026-10-14)

- Scratch `2X8cYvemgPmUJSZ5GWaeRB`: saved and working tree `58710ecd…`, 27 files, 4 exclusions; `main` tree `9ef37411…`; `no-base`, 1 differing path, 5 unreviewed commits (4 from `figma[bot]`), mirror `unsafe`. Exit 2.
- Hinge `ydPjoL41RjmufNbv93gPnq`: no baseline, so the sandbox-head tree `57fdde2b…` (packed objects) equals `main`'s tree; `in-sync`, 2 unreviewed bot commits, mirror `safe`, mode `ambiguous`. Exit 2.

Tests: `tests/make-project.test.js`, `tests/make-project-client.test.js`, `tests/make-sandbox-git.test.js`, `tests/make-git-tree.test.js`.
