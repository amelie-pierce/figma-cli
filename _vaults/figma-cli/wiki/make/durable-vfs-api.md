---
title: Make client VFS lookup compatibility
description: Current async entry lookup, text-entry guards, and the read-only verification boundary.
date: 2026-10-24
---

# Durable VFS API

Updated 2026-10-24: the current client exposes `fetchEntry(path)` instead of
`getFileEntryByPath(path)`. The durable page action awaits `fetchEntry` when
available, falling back to the old lookup only when the new method is absent.
Both receive an absolute project path. Lookup failures propagate; there is no
cache-only or deprecated-method fallback (`src/make-durable.js:59`).

`fetchEntry` can return a file, a directory, or null. Files retain the
`asyncContents` getter. The adapter accepts only string content, preserving
empty files and exact Unicode/newline bytes while rejecting directories and
non-text entries. A nullish entry is absent (`src/make-durable.js:63`,
`tests/make-vfs-api.test.js:7`, `tests/make-vfs-api.test.js:43`,
`tests/make-vfs-api.test.js:94`).

The same lookup serves durable reads and the final expected-content comparison
before `writeFile(path, content)` or `deleteFile(path)`. Their call signatures
are unchanged, as is `createVersion({ threadId, title })`; save still checks
the exact baseline and pending paths first (`src/make-durable.js:41`,
`src/make-durable.js:75`, `tests/make-vfs-api.test.js:65`,
`tests/make-vfs-api.test.js:124`). The marker caller therefore needs no special
fallback, and the serialized caller test also enforces exact-file identity
(`src/make-client.js:1156`, `tests/make-vfs-api.test.js:52`).

## Read-only live evidence and boundary

On 2026-10-24, a bounded React-fiber scan and prototype-method inspection on
Lab Management Application (`YBej9OBlqmwTX236XolhZj`, Desktop port 9333) found one
VFS with `fetchEntry`, `getCachedEntry`, and `deprecatedGetFileEntryByPath`, but
no `getFileEntryByPath`. The existing marker read reproduced the TypeError.
`writeFile`, `deleteFile`, and the sandbox `createVersion` function remained
present. These observations are modeled in the offline fixture
(`tests/make-vfs-api.test.js:7`).

With the adapter, `projectMarker()` returned null. Durable reads of `src/App.tsx`
(48 bytes, SHA-256 `5fd1add77fd0bb8fc5e2851652db612a3e13c6cf5fe27f1c85b95538c5db2d35`)
and `package.json` (585 bytes, SHA-256
`2e6f3ba99dbd8a4d567d2f058699451326aa73e3d95fb6a9e555654a99d4f7f2`)
matched sandbox remote reads exactly. Before and after, the saved git baseline
was `4265c2b0df924341d78441f8446e63adbdba486d` with zero pending paths.
The read-only call path is `src/make-client.js:1156` and `src/make-client.js:517`.

No live write, delete, mode switch, version creation, or deploy was performed.
Those live behaviors remain **UNVERIFIED** for this API revision; fake-VFS
tests establish mutation arguments and refusal behavior, not saved persistence
(`tests/make-vfs-api.test.js:65`, `tests/make-vfs-api.test.js:79`,
`tests/make-vfs-api.test.js:124`). The deploy worker must perform the first real
write after merge using the existing safeguards in [persistence.md](persistence.md)
and [deploy.md](deploy.md).

Use the offline Make suite for this repair. Broad `npm test` can reach a live
Design file through the roundtrip test; see [test-layout.md](../testing/test-layout.md).
