---
title: Large source files, size warnings and filesystem timeouts
description: Why one huge Make source file times out, the 5 s per-request cap that caused the ADC status timeouts, and the warn-only size rule on make status and make deploy.
date: 2026-11-04
---

# Large source files, size warnings and filesystem timeouts

Make reads and saves every file whole over its filesystem socket ([filesystem-bridge.md](filesystem-bridge.md)). One huge module is therefore the slowest request in any status, deploy or read. The ADC prototype's `Workspace.tsx` (about 493 KB, about 372 KB of it inline base64 PNGs) made `make status` fail with "Make filesystem request timed out; outcome is unknown."

## The per-request cap, not the command timeout

- `make status` already defaulted to `--timeout 120000` (`src/commands/make.js:199` before this change). The idea that a 15 s default timed out was wrong: 15000 is the default of `MakeClient` and of most other `make` commands (`src/make-client.js` constructor, `target()` in `src/commands/make.js`).
- The real fixed limit was inside the bridge. `_fileBridge` armed the page-side bridge with `Math.min(5000, remaining)` as `timeoutMs`, and `captureMakeFileSocket` uses that as every request's timer (`src/make-rpc.js:140`). So each filesystem request had 5 s whatever `--timeout` said; a later status that worked was not caused by `--timeout 120000`.
- Now each request may use the operation's remaining time less one second, so the page reports its own timeout before the CDP call does (`bridgeRequestTimeout`, `src/make-client.js:53`, the default of `_fileBridge`'s `requestTimeoutMs`). The exception is an absence check (`_durableAgreement` with `expectedContent === null`): Make never answers a listing of a missing folder, so its parent-walk opens the bridge with `Math.min(5000, remaining)` and each missing level still costs at most about 5 s (test: `tests/make-durable.test.js`). An inventory runs one `_operation` per batch of 24 entries (`inventoryProject`), so each batch gets the full `--timeout`.
- Read-only `make status` and `make read` add a hint to a timeout error (`timeoutHint`, `src/make-client.js:57`; `withClient(..., { readOnly: true })`, `src/commands/make.js:75`). Writes never get it: a timed-out write has an unknown outcome and must not just be run again.

## Size warnings (warn only)

- Rule and thresholds: `src/make-size.js` (150 KB, 1500 lines, 50 KB inline base64). Skipped: `vendor/`, `public/`, `docs/`, `guidelines/`, asset and generated modules, `.d.ts`, `.min.*`.
- `make deploy` dry run and apply check every file of `main` that is not deploy-ignored, reading content (`prepare`, `src/make-deploy.js:620`); the dry-run result carries `sizeWarnings`. The plan and digest do not change.
- `make status` knows only byte sizes (`workingBytes`, `src/make-client.js:1315`), so it checks size alone (`src/commands/make.js:220`). Warnings go to stderr and the JSON; the exit code is unchanged.
- Designer-facing wording lives in `skills/figma-make-team/SKILL.md` ("Keep files small").
