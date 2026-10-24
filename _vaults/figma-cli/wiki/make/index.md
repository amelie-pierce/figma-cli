# make/

- [cdp-page-discovery.md](cdp-page-discovery.md): how a Make command finds exactly one project page over CDP, and why project identity is the file key, never the title.
- [files-tab-resolution.md](files-tab-resolution.md): how source commands pick, reuse or open a Files workspace tab inside the project page.
- [filesystem-bridge.md](filesystem-bridge.md): why editor-based commands refuse deep files and Markdown, and how read/replace/import/verify/remove reach any file in the session's sandbox working copy through Make's own filesystem socket.
- [persistence.md](persistence.md): mode-specific Make saving, session-only CLI writes, the `--session-only` gate, durable writes to preview-only Markdown, root files Make does not list as pending, and `--first-version` for a never-saved git-mode file.
- [durable-vfs-api.md](durable-vfs-api.md): current async VFS lookup, text-entry guards, legacy compatibility, and read-only live proof of the API repair.
- [drift.md](drift.md): read-only hidden-file inventory, manifest comparison, and saved-state checks.
- [sync.md](sync.md): explicit Make/workspace delta and plan-bound sync with the Core token gate.
- [atomicaui-release.md](atomicaui-release.md): kit-hosted AtomicAUI release paths, guarded save and readback, and separation from vendor exchange.
- [status.md](status.md): read-only `make status`, git tree SHAs from Make's sandbox objects, the project-root inventory, solo/team mode and the write gate.
- [local.md](local.md): `make clone`, `install`, `pull` and `dev` for running a team-mode project from GitHub `main`; kit refusal, `.npmrc` handling and the frozen, script-free pnpm install.
- [team.md](team.md): `figma-cli team` verbs for designers; own-branch and push rules in code, save checks, conflict auto-resolution limits, and the current-head non-author approval for merge.
- [review.md](review.md): cross-review verbs (`team reviews`, `review`, `comment`, `approve`, `request-changes`, `feedback`, `address`); no self-review, no push from the detached review copy, commit-pinned approvals, and how Lavish notes map to pull request comments.
- [mode.md](mode.md): `make mode team|solo`, the only path that adds or removes the team marker; tree-checked save, gate exemption scope, reload verification and receipts.
- [deploy.md](deploy.md): `make deploy`, a repo admin's deploy of GitHub `main` into a team-mode Make file; guards, the `.figma-cli/deploy-ignore` list, content-compared plan, write order, receipt, tag and recovery stages, why root creates are refused, and the live proofs.
