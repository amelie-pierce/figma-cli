---
title: Make CDP page discovery
description: How a Make command binds to exactly one project page, and where project identity is enforced.
date: 2026-10-13
---

# Make CDP page discovery

- The port comes from `--port`, then `FIGMA_PORT`, then `~/.figma-cli/connection.json`, then 9222 (`src/lib/cdp-config.js:29`).
- Targets are read from `http://127.0.0.1:<port>/json` with redirects rejected (`src/lib/cdp-diagnostics.js:17`).
- Only `page` targets whose URL is `https://(www.)figma.com/make/<key>/…` and whose WebSocket is local on the same port count (`src/make-transport.js:50`, `src/make-transport.js:18`).
- `connect` keeps the targets whose key equals the requested key exactly; none or more than one is an error, so duplicate pages for one project are refused, not guessed (`src/make-transport.js:94`).
- Each Figma Desktop project tab is its own CDP page target. Titles change (Desktop shows the project name; inside the page a Files tab shows the selected filename), so titles are never used for identity (`tests/make-transport.test.js:78`, `tests/make-transport.test.js:92`).
- Every page evaluation is wrapped by `guardExpression`, which re-checks `location` against the connected key before running and throws "Make tab no longer matches the requested file key" otherwise (`src/make-client.js:149`, `src/make-client.js:210`). Because the check and the DOM action run in one synchronous page call, a click can never land in another project's page.

Related: [files-tab-resolution.md](files-tab-resolution.md).
