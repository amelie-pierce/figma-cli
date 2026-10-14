# make/

- [cdp-page-discovery.md](cdp-page-discovery.md): how a Make command finds exactly one project page over CDP, and why project identity is the file key, never the title.
- [files-tab-resolution.md](files-tab-resolution.md): how source commands pick, reuse or open a Files workspace tab inside the project page.
- [filesystem-bridge.md](filesystem-bridge.md): why editor-based commands refuse deep files and Markdown, and how read/replace/import/verify/remove reach any file in the session's sandbox working copy through Make's own filesystem socket.
- [persistence.md](persistence.md): mode-specific Make saving, session-only CLI writes, the `--session-only` gate, durable writes to preview-only Markdown, root files Make does not list as pending, and `--first-version` for a never-saved git-mode file.
- [drift.md](drift.md): read-only hidden-file inventory, manifest comparison, and saved-state checks.
- [sync.md](sync.md): explicit Make/workspace delta and plan-bound sync with the Core token gate.
- [status.md](status.md): read-only `make status`, git tree SHAs from Make's sandbox objects, the project-root inventory, solo/team mode and the write gate.
- [local.md](local.md): `make clone`, `install`, `pull` and `dev` for running a team-mode project from GitHub `main`; kit refusal, `.npmrc` handling and the frozen script-free install.
- [mode.md](mode.md): `make mode team|solo`, the only path that adds or removes the team marker; tree-checked save, gate exemption scope, reload verification and receipts.
