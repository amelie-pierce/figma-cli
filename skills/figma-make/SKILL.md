---
name: figma-make
description: Build and edit React applications directly in an existing Figma Make project using the Make-enabled figma-cli. Use for Make source changes, git-mode durable saves, session-source verification, and preview inspection. Figma Design canvas and FigJam edits use their own workflows.
---

# Figma Make

Work on the user's existing Make project through the CLI. Keep source readable,
preserve existing work, and verify both the session's files and the running app.
This skill requires the Make-enabled extension of figma-cli. Check the installed
commands rather than assuming an upstream installation includes it.

## Choose the saving mode

For the AtomicAUI library, use the `make atomicaui` command group. “Release a new
AtomicAUI version” maps to `release --file KEY` (optionally `--version X.Y.Z`);
the release command saves the files; the user rebuilds the site in **Make
settings → General** by clicking **Unpublish** (if already published) and then
**Publish**. Set **Who can view** to **Anyone on the web**, use no password, and
keep the existing address. The address can return 404 for about a minute.
**Update kit** and **Publish kit** do not rebuild the site.
After an interrupted unsaved release, use `release --version X.Y.Z --resume`;
after a save, use `verify-release --file KEY --version X.Y.Z` for a read-only
full path and hash check. Kit-only `public/atomicaui/**` files are excluded
from vendor drift, sync plans and export deltas.
“Add AtomicAUI to this app” maps to `add`, “update AtomicAUI in this app” to
`upgrade`, and “is AtomicAUI up to date?” to `status`. Direct solo Make writes
always require the exact `--file KEY`; team clone commands use `--dir` or the
current clone and open a normal review PR. These commands verify the public
HTTPS release before installation. See `src/commands/make-atomicaui.js` for
the command contract and `src/make-atomicaui.js` for the release format.
New releases write archive parts, the manifest, its sidecar hash, and the latest
pointer. The archive manifest still verifies every source file; the client
also supports the earlier direct-source release layout.
If a solo `add` or `upgrade` is interrupted before its save, inspect the
current Make state and rerun it with `--file KEY`, the same version and
`--resume`. It verifies every pending vendor, fix and wiring file and refuses
unrelated pending paths before completing one save.

The original writes (`replace`, `create`, `import`, `remove`) reach only the open
session's working copy. It is lost when the Make file is reopened unless Make
creates a saved version. Git-mode files create versions through Make's version
flow; older snapshot-mode files use the in-progress manual-edit Save card. The
four commands do not trigger either save flow. Git-mode files can instead use
`write` or `delete` through Make's client VFS, followed by `save-version`.
Snapshot-mode files refuse this durable path; their Save card is separate.
The four session-only commands refuse unless `--session-only` is passed. Before using them,
tell the user that the change is session-only and that they must save it in
Make to keep it; do not pass the flag without that understanding. Reads
(`read`, `files`, `verify`) see the same working copy, so a match proves the
session state, never that the project was saved. Report results that way.

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
- The adapter supports both Code/Preview and Files/Browser workspaces. Files tab
  titles may become filenames. A missing old Code tab is not a CDP permission
  failure: update the CLI adapter and use `make ui --file KEY` for bounded UI
  metadata. Preserve customized adapters when updating. If Files tabs exist with
  none active, the CLI reuses the first one on that exact project page. When no Files
  tab exists, the CLI automatically opens one through Add workspace tab → Files.
  Missing, disabled, or ambiguous menu controls stop the operation with an error.
  Do not patch/restart Desktop to fix a selector mismatch.
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
- For an authorized initial patch/restart, use `connect --make --port PORT`.
  This setup path uses direct OS helpers without Bash, CMD, PowerShell, or the
  Design daemon. It does not bypass OS permissions: Mac app modification may
  require App Management approval; Windows needs write/process permissions.
  If restricted, request approved IT setup. `FIGMA_APP_PATH` can identify a custom
  installation (.app bundle on Mac; Figma installation folder on Windows).

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

1. Check the mode first with `make status --file KEY` (add `--repo OWNER/REPO`
   when the user names the file's GitHub repo; this also records the link
   locally so later writes see it). In **team** mode the file
   deploys from GitHub `main`: do not write to Make; tell the user to start a
   task in the repo. All branching, saving, syncing, pull requests and merges
   in that clone go through `figma-cli team <verb>`; follow the
   `figma-make-team` skill and never improvise git. To run that repo locally use `make clone OWNER/REPO` (or
   `make clone --file KEY`), `make pull` and `make dev`; start `make dev` as a
   background job and poll the URL it prints, never wait on it. On a
   `MAKE_KIT_DEPENDENCY` refusal, explain the printed fix (vendor the kit by
   pull request); never copy Make's `.npmrc` or add tokens to the repo.
   Merged `main` reaches Make only through `make deploy`, which a repo admin
   runs in the clone (dry run first; see the `figma-make-team` skill).
   **Ambiguous** mode (a repo but no `.figma-cli/project.json`)
   needs the user's explicit go-ahead before passing `--solo`. **Solo** files are
   edited directly. To switch modes, only when the user asks, use
   `make mode team --repo OWNER/REPO` (add `--first-version` on a never-saved
   file; it reads the base itself, so no `--since`, e.g.
   `make mode team --first-version --file ydPjoL41RjmufNbv93gPnq --repo amelie-pierce/hcs-design-prototype`) or `make mode solo --yes-turn-off-team-mode` (repo admins only; show
   the user its warning first). Never write `.figma-cli/project.json` any other
   way; every other write command refuses it.
   Separate new paths from existing paths. For git-mode durable work, use
   `write` with the prior SHA-256 for an existing file, omit it for a new file,
   and use `delete` with the prior SHA-256 for removals. Keep backup paths.
   Markdown files have no Make editor; their write is verified through the
   client VFS, sandbox and tree. New files must go below an existing top-level
   folder, never directly under the project root.
   The original four commands retain their `--session-only` gate.
2. Add supporting modules and dependencies before replacing the entry point, so
   the app spends less time with unresolved imports. Imports are sequential,
   not atomic; do not run concurrent writers or assume rollback is automatic.
3. For durable work, call `save-version` with the exact pending path set and
   record its version ID and git SHA. Include root `AGENTS.md` or `CLAUDE.md`
   when you changed them: Make does not list them as pending, so the result
   reports them under `unlistedFiles` after a post-save read. A git-mode file
   that has never been saved (`make status`: `hasBaseline: false`) needs
   `--first-version`: note `make.head` from `make status` before writing, pass
   `--first-version` to `write`, then `save-version --first-version --since HEAD`
   with every path that changed since that commit. The flag is refused once the
   file has a version. Verify the expected final source with
   `make verify --manifest -`. Compare only
   files in scope; retain genuine vendor files byte-for-byte when unmodified.
   This verifies the working copy. For a saved version, reload the exact Make
   tab, confirm a fresh sandbox, and repeat hashes and `make drift`. For a vendor
   tree, run `make drift --file KEY --manifest VENDOR.json` to compare the complete
   hidden-file inventory and check Make's saved/pending state. Use an external
   `--receipt` when one exists.
   For AtomicAUI library exchange, use `make export-delta` on a clean saved
   version or `make sync` with a committed workspace package, explicit request,
   and trusted VENDOR.json. Review the dry-run plan and its unresolved conflicts
   before `--apply`. Apply rechecks the plan digest, Make version and inventory
   hashes, then writes a receipt. A component-only request requires full
   generated-token equality with the package; a token update also needs the
   committed `generated.manifest.json` sibling supplied separately. Commit the
   `<receipt>.VENDOR.json` apply writes; it is the next trusted manifest.
4. Run applicable syntax/type checks without violating the user's file constraints.
   Use `make preview --file KEY` to inspect the rendered headings, controls, error
   overlay, and overflow measurements. Preview inspection is not an interaction
   test, a production build, or proof of publication. State any untested boundary.
5. Finish with the Make link, the source changes, and the checks actually completed.
   Report the saved version or the session-only boundary.
   Keep publishing, sharing changes, installing elsewhere, and creating a fork
   separate from ordinary source editing unless the user requested them.

## When something fails

Do not replay a timed-out write or entire failed import. Files listed in
`sessionWrites` reached the session, and unlisted files may also exist. Read the affected files
and compare their current contents before choosing the next action.

For stale hashes, partial imports, missing editor readiness, or restore steps,
read [references/recovery.md](references/recovery.md). Preserve the user's current
work; stop dependent writes when project identity or the session state cannot be verified.
