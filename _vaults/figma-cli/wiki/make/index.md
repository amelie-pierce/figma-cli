# make/

- [cdp-page-discovery.md](cdp-page-discovery.md): how a Make command finds exactly one project page over CDP, and why project identity is the file key, never the title.
- [files-tab-resolution.md](files-tab-resolution.md): how source commands pick, reuse or open a Files workspace tab inside the project page.
- [filesystem-bridge.md](filesystem-bridge.md): why editor-based commands refuse deep files and Markdown, and how read/replace/import/verify/remove reach any file in the session's sandbox working copy through Make's own filesystem socket.
- [persistence.md](persistence.md): why every Make write is session-only and lost on reopen, how Make saves through its own Save, and the `--session-only` gate.
