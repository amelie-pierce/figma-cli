---
name: figma-make
description: Build and edit React applications directly in an existing Figma Make project using the Make-enabled figma-cli. Use for Make source changes, component-library imports, saved-file verification, and preview inspection. Figma Design canvas and FigJam edits use their own workflows.
---

# Figma Make

Work on the user's existing Make project through the CLI. Keep source readable,
preserve existing work, and verify both the saved files and the running app.
This skill requires the Make-enabled extension of figma-cli. Check the installed
commands rather than assuming an upstream installation includes it.

## Establish the connection

- Read workspace instructions and use their configured CLI launcher. Otherwise
  resolve `figma-cli` from PATH. The command examples below use `figma-cli` as a
  placeholder for that resolved executable; preserve its runtime/port setup.
  When the user requests Node execution or shell launchers are unavailable, resolve
  the installed `src/index.js` and invoke it with `process.execPath`, an argument
  array, and `shell: false`. Carry over the configured port/environment instead of
  invoking a `.sh` or `.cmd` wrapper. Use portable paths in shared instructions.
  Node installations record `nodeExecutable` and `cliEntry` in
  `~/.figma-cli/node-runtime.json`; read this local record when the package is not
  on PATH. Verify its owner is `amelie-pierce/figma-cli` and both files still exist.
  Keep these machine-specific values local; do not copy them into shared docs.
- Check `make --help` for the commands needed by the task. If `make`, `create`, or
  `import` is missing, report the installed capability gap; do not invent a fork
  URL or assume upstream has the extension.
- Use `make list` to find the open project, then `make inspect --file KEY` with
  the exact key from the user's `/make/KEY/...` URL. Do not choose by title alone
  or use Design's `FIGMA_FILE` setting for Make.
- If discovery fails, run `connection` for a read-only diagnostic. Report the
  endpoint, port source, and underlying error. Port precedence is `--port`,
  `FIGMA_PORT`, saved `~/.figma-cli/connection.json`, then 9222. Every Make command
  accepts the global `--port`; persist a known Desktop port with
  `connection --save-port PORT`. Installation accepts `--port PORT` too, but
  does not enable or verify debugging. Do not copy a different device's port.
  An unreachable port alone cannot distinguish wrong configuration from disabled
  debugging. App Management guidance applies to an actual macOS patch permission
  error, not every connection failure. A CDP target is not editor-readiness proof.
- The project must be open and loaded in Figma Desktop. A healthy Make connection
  needs no `connect`, app patch, restart, or additional MCP login. For a missing
  connection, follow the installed CLI's setup guidance and existing authorization;
  do not reuse a Chrome debugging port or kill another service.

Use Node/CLI commands for the whole source workflow, including discovery and
verification. Do not invoke computer-use tools, OS mouse/keyboard automation,
screenshot-coordinate clicking, separate browser-automation tools, Make prompts,
Design `eval`/`render`, or hand-written private service calls. Do not silently fall
back to any of these when the CLI fails; report the exact blocker instead. The CLI owns the desktop adapter and transport. If a capability is missing,
explain it; changing the CLI itself is a separate scope unless already authorized.

## Read enough to plan the change

Run `make files --file KEY` once to understand the tree. Read the relevant entry
point, `package.json`, styles, and any project instructions with `make read PATH`.
Read only modules that affect the requested change; keep the returned content
and SHA-256 in memory for subsequent edits and verification.

Choose a small, coherent file set. Preserve unrelated screens and assets. When
several agents are authorized, parallelize preparation or review, but assign one
writer to each Make project: file selection and editor state are shared.

## Prepare editable source

- Write conventional React/TSX with imports, named components, hooks, and JSX.
  Format authored source. Do not put compiled/minified bundles, dependency shims,
  or generated runtime code into `App.tsx` as a shortcut.
- Keep reusable library modules separate from the app. Use an existing supported
  package or genuine source files; preserve vendor source, license, and provenance.
  For a vendored subset, resolve the transitive runtime **and type** import graph.
  Do not guess package names or replace requested library components with lookalikes.
- Merge required dependencies into the existing root `package.json`. Preserve
  unrelated scripts and dependencies. Check real provider/prop types, styles,
  fonts, and assets rather than relying on a prior bundled build to hide errors.
- Default to preparing source and manifests in memory and sending stdin. When the
  user requests no local application code, do not create scratch app files, build
  outputs, or source copies. CLI recovery backups are distinct; disclose a conflict
  if the user also prohibits backups. Existing authorized source files may be read.

For exact commands and safe in-memory examples, read
[references/commands.md](references/commands.md) when preparing a write.

## Apply and verify

1. Separate new paths from existing paths. Use `create` or `import` only for new
   files. Use `replace` with the prior SHA-256 for existing files. Keep all backup
   paths returned by the CLI.
2. Add supporting modules and dependencies before replacing the entry point, so
   the app spends less time with unresolved imports. Imports are sequential,
   not atomic; do not run concurrent writers or assume rollback is automatic.
3. Verify the expected final source with `make verify --manifest -`. Compare only
   files in scope; retain genuine vendor files byte-for-byte when unmodified.
4. Run applicable syntax/type checks without violating the user's file constraints.
   Use `make preview --file KEY` to inspect the rendered headings, controls, error
   overlay, and overflow measurements. Preview inspection is not an interaction
   test, a production build, or proof of publication. State any untested boundary.
5. Finish with the Make link, the source changes, and the checks actually completed.
   Keep publishing, sharing changes, installing elsewhere, and creating a fork
   separate from ordinary source editing unless the user requested them.

## When something fails

Do not replay a timed-out write or entire failed import. Acknowledged files may
already be saved, and unacknowledged files may also exist. Read the affected files
and compare their current contents before choosing the next action.

For stale hashes, partial imports, missing editor readiness, or restore steps,
read [references/recovery.md](references/recovery.md). Preserve the user's current
work; stop dependent writes when project identity or persistence cannot be verified.
