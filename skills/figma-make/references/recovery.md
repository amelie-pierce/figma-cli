# Recover without losing work

## A write or import timed out

1. Preserve the error's backup path, `sessionWrites`, and `requestedPaths` data.
2. Run `make files --file KEY` again. Do not assume a path missing from `sessionWrites` is absent.
3. Read affected existing files and compare their current contents to the intended
   source. Use `verify` on the subset known to exist for an exact session comparison.
4. If a file matches, leave it. Import only absent paths. For differing content,
   inspect the difference and either merge the authorized change using its current
   hash or stop if ownership/intent is unclear. Do not overwrite a collaborator's
   changes with an old manifest.

Imports are not atomic and errors do not trigger rollback. Automatic retry of the
entire batch is incorrect, even when only one failure was reported.

## Replacement rejected a stale hash

A stale hash, or `outcome: "refused"`, means no write was sent. Read the file again. Preserve and understand the intervening edits before applying
the requested change to that version. Merely substituting the new hash while keeping
stale replacement content defeats the guard.

## Editor or connection is unavailable

Keep recovery on the Node/CLI path. Do not switch to computer-use tools,
mouse/keyboard control, screenshot clicking, or separate browser automation.
If CLI recovery cannot establish readiness, report the exact blocker and ask for
only the missing prerequisite. Keep the existing source intact.

Use `make list` and `make inspect` to distinguish a missing/wrong project from a
loading, busy, offline, or read-only editor. Use bounded checks after an observed
loading transition; do not repeatedly issue writes to probe readiness.

If the file is not open, ask the user to open the exact project in Figma Desktop.
Do not reload the desktop CDP page, restart a healthy app, or switch to Design's
daemon as a workaround. `connect` can patch/restart Figma; follow the installed
setup instructions and authorization rather than treating it as a harmless read.

`read` and `replace` do not depend on the file-tree viewport. `diagnostics` and
the editor read fallback do: if the source tree cannot verify an ancestor/path, do
not guess by basename. The CLI normally collapses unrelated folders during
selection. If it still refuses, report the limitation with the exact path.

If a command reports that no Make filesystem connection was observed, nothing was
written. The project tab was probably in the foreground with its connection
already open; switch to another Figma tab, wait a minute, and run it again once.
If it fails again, report the blocker instead of retrying.

## Session writes disappeared after a reopen

Expected: Make writes are session-only. Reopening the file rebuilds the working
copy from the last saved Make version, so unsaved CLI writes are gone. Nothing
is broken. Tell the user, then rewrite the change only if it is still wanted,
and ask them to save it in Make (Save on the in-progress manual-edit card)
before reopening. Whether that Save captures CLI writes is UNVERIFIED.

## Restore or clean up

Restore only within the authorized scope. Read the current file, then replace from
the returned recovery backup using that current hash after checking for intervening
changes. Backups normally live under `~/.figma-cli/make-backups`; retain the exact
path from the operation, rather than guessing which backup is newest.

For explicitly authorized cleanup, `make remove PATH --file KEY --expected-sha256
HASH --session-only` backs up and removes one exact text file. It is not recursive folder deletion.
Verify the target and its current hash first. Do not remove unrelated files to make
an import succeed. A failed removal is also an uncertain outcome: inspect before
retrying or restoring.

## Source matches but preview fails

Read the relevant imports, dependency manifest, and actual error overlay. Resolve
missing modules/packages, incorrect exported names, or provider/prop types in the
source. Do not flatten everything into a compiled bundle to bypass module errors.

After a fix, verify source again and inspect the preview. Report type checks,
session source state (unsaved until the user saves in Make), rendered preview,
interaction tests, and publication as separate facts. Keep unsupported checks explicitly unverified.
