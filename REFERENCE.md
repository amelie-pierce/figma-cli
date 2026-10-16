# figma-ds-cli Command Reference

Full command reference for the Figma CLI. For quick start, see CLAUDE.md.

## Node installation

Launch the extracted package's `install.mjs` with Node, optionally passing
`--agent copilot` (or `all`, `claude`, `codex`). It installs dependencies using
npm's JavaScript entry point with `--ignore-scripts` and `--no-bin-links`, then
registers and verifies the skills without a shell. `--npm-cli PATH` selects a
separately installed `npm-cli.js`. It does not connect to Figma. See
[Node installation and Copilot setup](README.md#install-with-nodejs-including-github-copilot).

## Direct Node.js invocation

`figma-cli` examples name the command, not a required shell. A Node runner can
invoke the installed `src/index.js` with `process.execPath`, an argument array,
and `shell: false`. Preserve the configured `FIGMA_PORT` or pass `--port`.
See [the portable Node example](README.md#run-directly-from-nodejs) and
[stdin transfer pattern](skills/figma-make/references/commands.md#transfer-source-safely).

## Agent skills

`figma-cli skills install` registers all bundled skills for Claude Code, Codex,
and GitHub Copilot. `figma-cli skills status` reports exact paths and exits nonzero
when registration is incomplete. Both support `--agent all|claude|codex|copilot`.
Installation preserves custom skills and modified managed copies. See README.md
for automatic npm registration, opt-out, and the documented discovery directories.

## Figma Make source files (experimental)

The `make` command group reads, creates, imports, and edits UTF-8 source files in an open Figma
Make Code editor. It uses a separate desktop connection; Design commands and
the Design daemon are unchanged. Select a project with its exact Make URL or
file key, never a title. Use the workspace's configured launcher and dedicated
debugging port. Precedence: global `--port`, `FIGMA_PORT`, saved local port, then
9222. The global option also works after the Make subcommand (`make list --port
PORT`). Use `connection --save-port PORT` to persist a known port in
`~/.figma-cli/connection.json`, or `install.mjs --port PORT` during Node installation.
Neither setting a port nor installing enables Desktop debugging.

`connection` performs a bounded, read-only endpoint check and reports the port,
source, exact URL, target counts, and recovery guidance. It does not patch, restart,
scan, or edit. An unreachable endpoint cannot alone distinguish disabled debugging
from a wrong port. `connect` checks the CDP endpoint after patch/restart and reports
patch permission failures separately. For Node-only Make setup, use
`connect --make --port PORT`: it reuses a healthy endpoint or launches Desktop via
direct OS helpers without a shell or Design daemon. App-modification/process
permissions are still required. Mac discovery includes system and user Applications;
Windows uses the newest complete numeric version. `FIGMA_APP_PATH` selects a custom
`.app` bundle (Mac) or installation folder (Windows).
A successful check is not editor-readiness
proof; follow with `make inspect`. No computer-use fallback is required or allowed.

Both the older Code/Preview radio tabs and the newer Files/Browser workspace are
supported. Files tabs are identified by their controls, even after their title
changes to a filename. The current visible file tree and header identify the active
Files pane; the full breadcrumb must match the selected source path before a read
or write. If Files tabs exist but none is active, the CLI selects the first one in
tab order. Every Files tab on a page belongs to that page's project, whose exact
file key is checked before each action, so tabs are never matched by title. Only
if no Files tab exists does the CLI open one through
**Add workspace tab → Files**, waiting for the menu and file tree to become ready.
Unavailable, disabled, or ambiguous controls stop the operation without a source edit.
`make ui --file KEY` reports bounded control metadata without selecting tabs or
reading source/input values. Use it for an unsupported layout. The old error
`Expected exactly one Make Code tab` may indicate an outdated CLI adapter, not a
missing project or a Desktop debugging/patch permission problem.
After a Desktop restart, a restored background project may have a zero-size
workspace until selected. `make ui` includes control dimensions to distinguish
this state. Select that project tab and show its workspace manually; the CLI
refuses to operate on hidden/unlaid-out workspace controls.

```sh
figma-cli make list
figma-cli make inspect --file <make-file-key>
figma-cli make ui --file <make-file-key>
figma-cli make files --file <make-file-key>
figma-cli make read src/App.tsx --file <make-file-key>
figma-cli make read guidelines/Guidelines.md --remote --file <make-file-key>
figma-cli make diagnostics src/App.tsx --file <make-file-key>
figma-cli make replace src/App.tsx --file <make-file-key> --from - --expected-sha256 <hash-from-read> --session-only
figma-cli make create src/Component.tsx --file <make-file-key> --from - --session-only
figma-cli make import --file <make-file-key> --manifest - --timeout 120000 --session-only
figma-cli make verify --file <make-file-key> --manifest - --timeout 120000
figma-cli make drift --file <make-file-key> --manifest VENDOR.json --timeout 120000 --json
figma-cli make status --file <make-file-key> --repo <owner/repo> --json
figma-cli make mode team --file <make-file-key> --repo <owner/repo> [--first-version] [--dry-run]
figma-cli make mode solo --file <make-file-key> --yes-turn-off-team-mode [--first-version] [--dry-run]
figma-cli make clone <owner/repo> [dir]
figma-cli make clone --file <make-file-key> [dir]
figma-cli make install [dir]
figma-cli make pull [dir]
figma-cli make dev [dir]
figma-cli team start "<task name>" [--save-first] [--dir <clone>]
figma-cli team save [-m "<message>"]
figma-cli team sync
figma-cli team conflicts
figma-cli team pr [--title "<title>"]
figma-cli team merge [--no-build-check]
figma-cli team merge --force --reason "<why it cannot wait for a review>"
figma-cli team status [--no-fetch]
figma-cli team reviews
figma-cli team review <pr|login> [--lavish] [--app] [--no-install] [--remove]
figma-cli team comment <pr> -m "<text>" [--file <path> --line <n> [--old]] [--selector "<css>"] [--source <file:line>] [--text "<element text>"]
figma-cli team approve <pr> [-m "<note>"]
figma-cli team request-changes <pr> -m "<what should change>"
figma-cli team feedback [pr]
figma-cli team address [pr]
figma-cli make export-delta --file <make-file-key> --manifest VENDOR.json --who engineer --candidate-dir candidates --out delta.json
figma-cli make sync --file <make-file-key> --package kit-package --manifest VENDOR.json --request request.json --candidate-dir candidates --plan-out plan.json
figma-cli make sync --file <make-file-key> --package kit-package --manifest VENDOR.json --request request.json --candidate-dir candidates --apply plan.json --receipt-out receipt.json
figma-cli make write src/App.tsx --file <make-file-key> --from - --expected-sha256 <hash-from-read>
figma-cli make write src/New.ts --file <make-file-key> --from -
figma-cli make delete src/Old.ts --file <make-file-key> --expected-sha256 <hash-from-read>
figma-cli make save-version --file <make-file-key> --title "Reviewed edit" --expected-path src/App.tsx --expected-path src/New.ts --receipt-out receipt.json
figma-cli make write src/New.ts --file <make-file-key> --from - --first-version
figma-cli make save-version --file <make-file-key> --first-version --since <head-from-status> --title "First version" --expected-path src/New.ts --receipt-out receipt.json
figma-cli make preview --file <make-file-key>
```

### Make saving modes and write commands

Every Make write (`replace`, `create`, `import`, `remove`) goes through the
filesystem connection into the open session's working copy, a per-session
sandbox. **It is not saved to the project.** Make saves source only through its
own save flow: git-mode files create a version, while older snapshot-mode files
use the manual-edit Save card. The original four commands never trigger either flow. When the file is reopened, the working copy is
rebuilt from the last saved version and session writes are gone: on 2026-10-13,
39 files written with `make import` read back with matching SHA-256 in the same
session and were missing after a reopen.

- The four write commands refuse before connecting unless `--session-only` is
  passed, with `code: "MAKE_SESSION_ONLY_REQUIRED"`. The flag only accepts the
  limitation; every other check (expected SHA-256, backup, read-back) still runs.
- Completed writes report `persistence: "session-only"` and a `note`.
  `verification` names what was checked in the session: `session-readback-matched`
  (`replace`, `create`, `import`) or `session-delete-accepted` (`remove`).
- Reads (`read`, `files`, `verify`) read the same working copy. They equal the
  saved project only when no session write or manual edit is pending, so they
  confirm session state, not persistence.
- The save flow depends on the Make file's mode. The four session-only commands
  still cannot prove that their bytes reached a saved version.

`make write` and `make delete` use Make's client VFS in git mode. An existing
file requires `--expected-sha256`; a new file omits it. Replaced or deleted
bytes receive a private backup. The CLI checks the client VFS, file tree, editor
(for existing or newly written files), and session sandbox before reporting a
pending write. Make shows Markdown as a preview without an editor; when a `.md`
file shows no editor within a few seconds, the client VFS, sandbox and tree
must agree instead (`verification: "tree-vfs-sandbox-matched"`). Every other file still needs its editor to match.
If the views still disagree at the timeout, the error names each view's state.
A new file must sit below an existing top-level folder: the write proves
absence by listing an existing ancestor folder, never the project root, so a
root-level write is refused before anything changes. Snapshot-mode files are refused. A pending
write is not saved.

`make save-version --title TITLE --expected-path PATH ...` calls Make's own
in-page `createVersion` only when the complete pending path set matches the
supplied paths. It records the version ID, number, full git SHA, previous SHA,
and changed-file set; `--receipt-out` writes these to a new private JSON file.
The CLI then checks that Make reports the new baseline and no pending changes.
At least one expected path is required, so a clean file never gets an empty version.
Make hides root `AGENTS.md` and `CLAUDE.md` from its pending list although
`createVersion` commits them. These two allowlisted paths may be expected
without being listed: their client VFS and sandbox bytes must agree before the
save and read back unchanged after it, and the result lists them under
`unlistedFiles` with SHA-256. Any other expected path must be pending, and an
unexpected pending path is still refused.

**First version.** A git-mode file that has never been saved (`make status`
reports `hasBaseline: false`) has nothing to diff against. Make lists no pending
files without a baseline, and its sandbox commits every write to its own git
`main`, so the sandbox HEAD does not show the change either. `write`, `delete`
and `save-version` refuse such a file unless `--first-version` is passed, and
refuse the flag once the file has a saved version. To create the first version:

1. Run `make status` and note `make.head`, the sandbox commit before your writes.
2. Write with `make write … --first-version` (or `make delete … --first-version`).
3. Run `make save-version --first-version --since <that head> --expected-path …`.

The CLI checks that `--since` is in the sandbox HEAD's history and that the
expected paths equal exactly the paths that differ between that commit's tree
and the working copy. It rechecks Make's state and the sandbox HEAD, then calls
`createVersion`. Finally it waits until Make reports the new baseline with no
pending changes, and checks that the saved version's tree equals the working
tree it checked. The result has `firstVersion: true`, `previousGitSha: null`,
`since`, `tree` and `verification: "first-version-clean-baseline; saved-tree-matched"`.
Root `AGENTS.md` and `CLAUDE.md` get no exception here: they appear in that
difference like any other path. After the first version, use the commands
without the flag.
If the version is created but the clean baseline is not observed, the error
reports the version ID, number and git SHA, and `--receipt-out` is still
written; do not retry the save.
After a timeout or uncertain result, inspect Make before retrying. A fresh
sandbox reload plus `make drift` and source hashes gives persistence proof;
the save response alone does not.

`make drift --file KEY --manifest VENDOR.json [--receipt receipt.json] [--root PATH] [--json]`
is read-only. It recursively lists the root through Make's filesystem bridge with
hidden entries included, reads every file as raw bytes, and reports per-file byte
counts and SHA-256. Manifest paths are relative to the root; `VENDOR.json` itself
must match the supplied manifest. It reports matched, mismatched, missing and extra
files, Make's saving mode, saved git SHA and pending-change count. Exit status is
zero only when all files match and Make reports a clean saved git version. Snapshot
mode and missing, conflicting or changing persistence state fail closed. Make's
saving state is read from direct Make provider props in its React tree, so
large unrelated graphs do not hide the saving mode. `scanTruncation` is always
zero and remains in JSON output only for compatibility.
Optional external
receipts must pin `fileKey`, the raw `manifestSha256` and full
`savedVersionGitSha`; a stale receipt fails. `--manifest -` reads stdin. The
default root is `src/vendor/atomic-aui`; the default timeout is 120 seconds.
Each renderer inventory batch is bounded to 24 directory/file calls; the saved
version and pending set are checked across batches. When present,
`tokens/generated.manifest.json` is parsed and checked against the exact
generated tree, including `.generated` and `splash-bootstrap.js`.

### Make project status and solo/team mode

`make status --file KEY [--repo OWNER/REPO] [--json]` is read-only for Figma and
GitHub. It reports:

- **Make:** saving mode, saved version, pending count and paths, the git **tree
  SHA** of the saved version, and the tree SHA of the working copy.
  - The saved tree is read from the version's own commit in the sandbox's
    `.git` objects (loose or packed), so file modes are exact. Make commits
    template files as `100755` and later edits as `100644`.
  - The working tree re-hashes every file under the project root, hidden ones
    included. A file whose blob equals the saved tree keeps that mode; any
    other file takes `100644`.
  - Excluded, never read: `.git`, `.npmrc`, `.figma/design-context/`, and
    what the sandbox's `.git/info/exclude` (read at run time) and each folder's
    `.gitignore` ignore. As in git, a path in the saved tree is kept even when
    an ignore rule matches it (a committed `dist/` is hashed); an untracked
    `node_modules/` is skipped.
  - Without a saved version, the sandbox HEAD's tree is used (`treeSource:
    "sandbox-head"`). An unreadable sandbox `.git` fails the status (exit 1).
  - The newest AI-turn version, since an AI turn saves every pending edit.
- **Mode**, from the committed `.figma-cli/project.json` in Make's working copy
  (`{"fileKey", "repo", "trunk"?}`):
  - `team`: the marker names this file;
  - `ambiguous`: no marker, but a repository is known: from `--repo`, or from
    the link a prior `make status --repo` recorded (Make exposes no readable
    GitHub link);
  - `solo`: neither;
  - `invalid`: the marker is unreadable or names another file.
- **With `--repo`**, through your own `gh` login (GET requests only). When the
  repo reads, the file key → repo link is recorded locally in
  `~/.figma-cli/make-repos.json` (never in the repo or in Make):
  - `main`'s commit and tree, and the latest `make-deploy/<n>` tag with its
    base, the tagged commit's tree (a tag receipt naming a different
    `mainTree` is reported as `receiptMismatch`);
  - `relation`: `in-sync`, `make-ahead`, `git-ahead`, `diverged`, or `no-base`
    when there is no tag, plus the differing paths;
  - `unreviewed`: commits on `main` since the base (all history without one, up
    to 100) that did not come from a merged PR into `main`; `fromMake` marks
    `figma[bot]` Push commits;
  - `permission` (`admin` … `none`); only `admin` may deploy;
  - `mirror`: whether Make's Push, which sends the working copy, would overwrite
    commits not made by Make (`safe`, `unsafe` or `unknown`). A default branch
    other than `main` is flagged.
  - Paths that root `.gitattributes` routes through LFS are compared outside the
    tree join: Make stores the pointer, Push sends the raw bytes.

Exit status: `0` when everything was read and nothing needs attention, `1` when
Make or GitHub could not be read, `2` when the read completed with `attention`
items (pending changes, no baseline, ambiguous mode, any relation other than
`in-sync`, unreviewed commits, an unsafe mirror, and so on).

**Write gate.** Every Make write (`write`, `delete`, `save-version`, `sync`, and
the session-only `replace`, `create`, `import`, `remove`, which still require
`--session-only`) reads the marker through Make's client VFS, and the recorded
repo link, before doing anything:

- team mode refuses with `code: "MAKE_TEAM_MODE"` ("this file deploys from
  <repo>; say start a task"), even with `--solo`;
- an unreadable or mismatched marker refuses with `MAKE_MARKER_INVALID`;
- a repo without a marker (`--repo OWNER/REPO`, or a link recorded by
  `make status --repo`) makes the mode ambiguous, which refuses with
  `MAKE_MODE_AMBIGUOUS` unless `--solo` is passed (then it warns);
- solo mode writes as before, with a one-line stderr note that team mode is
  detected only through the marker or a prior `make status --repo`.

No write command may name `.figma-cli/project.json` itself, in any mode
(`MAKE_MARKER_RESERVED`); `save-version --expected-path` included.

**Mode toggle.** `make mode team|solo` is the only way to add or remove the
marker, and it skips the write gate for that one path:

- `make mode team --repo OWNER/REPO` writes `{fileKey, repo, trunk: "main"}`
  through the durable write. `make mode solo` deletes the marker after a
  SHA-256 check. Each saves the change as its own Make version
  (`figma-cli: team mode on (<repo>)` / `figma-cli: team mode off`).
- Make does not list paths under `.figma-cli/` as pending, so the save is checked
  as a tree: the working copy may differ from the saved version only in the
  marker, Make may list nothing pending, and the saved tree must equal the
  working tree that check read. `--first-version` does the same for a
  never-saved file against the sandbox head it reads itself before writing the
  marker, so no `--since` is needed. Only a marker already in the working copy
  but written outside `make mode` needs `--since <sha>`: the sandbox head
  `make status` reported before that write (`MAKE_MODE_SINCE_REQUIRED`).
  Example, a never-saved file's first save:
  `figma-cli make mode team --first-version --file ydPjoL41RjmufNbv93gPnq --repo amelie-pierce/hcs-design-prototype`.
- It then reloads only that Make tab and checks that Make reports the new
  version as a clean baseline, and that the saved tree, the sandbox and the
  client VFS all hold exactly the new marker (or none).
- It refuses other pending or unsaved paths (`MAKE_MODE_OTHER_PENDING`), a
  marker naming another file or repo (`MAKE_MODE_MISMATCH`), an unusable marker
  on `team` (`MAKE_MARKER_INVALID`), and no-ops (`MAKE_MODE_UNCHANGED`). A marker
  written or removed but never saved is saved rather than refused; an unsaved
  removal needs the locally recorded repo link for its admin check.
- `solo` checks admin rights on the marker's repo, or on the locally recorded
  link when the marker names no readable repo. It records that link before it
  deletes, so a removal whose save failed can be finished by re-running
  `make mode solo --yes-turn-off-team-mode`.
- `team` reads the repo through `gh` (GET only) and records the local link;
  `solo` prints a warning, requires the caller to be an admin of the marker's
  repo (`MAKE_MODE_NOT_ADMIN`, also when `gh` cannot read it), needs
  `--yes-turn-off-team-mode` (`MAKE_MODE_CONFIRM_REQUIRED`) and drops the local
  link so later writes are solo, not ambiguous. `--dry-run` reports the plan,
  warning and permission without writing.
- A receipt (`who`, file, repo, action, marker SHA-256, version id, number and git
  SHA, tree, verification) is written to `~/.figma-cli/mode-receipts/` (mode
  0600). A failed reload check writes a receipt with `verification: "failed"`.

### Running a team-mode project locally

In team mode GitHub `main` is the source of truth, so people run the app from a
local clone. `make clone`, `make install`, `make pull` and `make dev` never write
to Make or GitHub; they use your own `gh` and `git` logins, and figma-cli stores
no tokens. They always target `main` explicitly, never the repo's default branch.
Errors are JSON on stderr with a `code`; results are JSON on stdout.

- `make clone OWNER/REPO [dir]` runs `gh repo clone OWNER/REPO dir -- --branch main`
  (dir defaults to the repo name and must be new or empty,
  `MAKE_CLONE_TARGET_EXISTS`), then installs as `make install` does. With
  `--file KEY [dir]` the repo comes from the open Make file's team marker
  `.figma-cli/project.json` (read-only, the same client VFS read as the write
  gate). A file with no marker, a marker for another file, an invalid marker or a
  non-`main` trunk refuses (`MAKE_CLONE_NO_REPO`). When the install step refuses,
  the clone stays and the error carries its `dir`.
- `make install [dir]` checks the toolchain against `.mise.toml` `[tools]`
  (`node`, `pnpm`/`npm:pnpm`), `package.json` `engines` and `packageManager`,
  each run in the clone so mise or corepack shims report its versions:
  version mismatches only warn, a missing pnpm refuses
  (`MAKE_TOOLCHAIN_MISSING`). It warns on any tracked `.npmrc` that holds
  `_authToken`, `_auth` or `_password`, naming path and line only. It refuses
  any `@make-kits/*` dependency or `figma.kitAttachments` entry
  (`MAKE_KIT_DEPENDENCY`): a kit attached in Make's UI resolves only through
  Make's Figma-managed registry, so a local install fails with a 404. The fix is
  to vendor the kit's source by pull request (`src/vendor/<kit>/` pinned by
  `VENDOR.json`) and drop the dependency, or get registry access into your own
  `~/.npmrc`. Make's `.npmrc` is git-excluded and never copied. The install is
  pnpm only, frozen and script-free: `pnpm install --frozen-lockfile
  --ignore-scripts`. A repo without `pnpm-lock.yaml`, or whose `packageManager`
  names anything other than pnpm, refuses (`MAKE_NO_LOCKFILE`).
  Make's own install uses `--no-frozen-lockfile`; locally the lockfile changes
  only in dependency pull requests.
- `make pull [dir]` fetches `origin main` and fast-forwards local `main` only.
  It refuses when local `main` has commits that are not on GitHub
  (`MAKE_PULL_LOCAL_COMMITS`; that work belongs on a task branch, which the
  `team` verbs never move commits off `main`) and when checked-out `main` has uncommitted
  tracked changes (`MAKE_PULL_DIRTY`). On another branch only the local `main`
  ref moves. It reinstalls only when `pnpm-lock.yaml` changed, with the same checks.
- `make dev [dir]` runs `pnpm run dev` (the same command as Make's
  `.figma/make/dev`) and refuses when `package.json` has no `scripts.dev`
  (`MAKE_NO_DEV_SCRIPT`). It needs installed
  dependencies (`MAKE_NOT_INSTALLED`), mirrors the server's output, prints
  `figma-cli: local URL <url>` once on stderr, forwards Ctrl-C and exits with the
  server's code. It runs until stopped: **agents start it as a background job
  and poll the printed URL** (for example `curl -sf http://localhost:5173/`)
  instead of waiting for it to return.

### Deploying main to Make (`make deploy`)

In team mode the only Make write is a deploy of GitHub `main`, run by a repo
admin from a local clone. Results are JSON on stdout with a plain `summary`;
errors are JSON on stderr with a `DEPLOY_*` `code` and, once anything was
written, the `receiptPath`.

```bash
figma-cli make deploy --file KEY [--dir CLONE]   # dry run (default)
figma-cli make deploy --file KEY [--dir CLONE] --apply PLAN
figma-cli make deploy --file KEY [--dir CLONE] --verify RECEIPT
figma-cli make deploy --file KEY [--dir CLONE] --resume RECEIPT
figma-cli make deploy --file KEY --abort RECEIPT
```

Guards, each refusing with nothing written:
- the Make file is in team mode (`DEPLOY_SOLO`: a solo file has nothing to deploy
  from; `DEPLOY_NOT_TEAM`: ambiguous or invalid marker) and the clone's origin is
  the marker's repo (`DEPLOY_REPO_MISMATCH`);
- your `gh` login has `admin` on the repo (`DEPLOY_NOT_ADMIN`, GET requests only);
- the clone is on `main` (`DEPLOY_NOT_MAIN`), clean (`DEPLOY_DIRTY`), and after a
  fetch `HEAD` equals `origin/main` (`DEPLOY_NOT_CURRENT`); that commit came from a
  pull request merged into `main` (`DEPLOY_UNREVIEWED`), since `main` is unprotected
  and review is a convention;
- `make install`'s checks and `pnpm install --frozen-lockfile --ignore-scripts`
  pass (`DEPLOY_INSTALL_FAILED`; a `@make-kits/*` dependency refuses here), the
  `build` script passes (`DEPLOY_BUILD_FAILED`) and leaves no file git sees;
- Make is idle, in git mode with a saved version, with nothing pending or unsaved
  and no AI generation running (`DEPLOY_MAKE_BUSY`, `DEPLOY_MAKE_STATE`,
  `DEPLOY_MAKE_AHEAD`);
- Make's saved tree equals the tree of the newest `make-deploy/<n>` tag's
  commit (`DEPLOY_MAKE_AHEAD`: Make was edited outside deploys; bring the edits
  into `main` first with the coming `make rescue` step). A tag receipt naming a
  different `mainTree` is refused (`DEPLOY_MAKE_STATE`). The first deploy's base is
  Make's saved tree. No earlier deploy of the file may be unfinished
  (`DEPLOY_UNFINISHED` names the recovery command).

The plan compares `main`'s tree with Make's saved tree by content (Make commits
files it writes as `100644`, so mode-only differences are listed, not written).
`.npmrc`, `.figma/design-context/` and the repo-only project vault `_vaults/`
are never deployed (`make status` leaves `_vaults/` out of its comparison too); `.figma-cli/project.json`
is kept in Make when `main` has none, and refused when `main`'s names another file
or repo (`DEPLOY_MARKER`). Binary files and files over 2 MiB (`DEPLOY_BINARY`),
LFS paths that differ (`DEPLOY_LFS`), and new or deleted files directly in the
project root or in a new top-level folder, submodules and symbolic links
(`DEPLOY_UNSUPPORTED_PATH`) are refused. Lockfiles are written first and the root
`package.json` last, because Make reinstalls when `package.json` changes. The
plan records each path's operation and before/after SHA-256 and git blob, the
next tag number and a digest; it is written to `~/.figma-cli/deploys/plans/`.

`--apply` runs every guard again and re-plans: the digest must match the reviewed
plan, `origin/main` must still be the planned commit (`DEPLOY_MAIN_MOVED`) and
the tag number must be free (`DEPLOY_TAG_CLASH`). It then writes each path with
the durable client-VFS write (backups under `~/.figma-cli/deploys/backups/`).
The root dependency files go last (`package.json`, then the lockfiles), because
Make runs its own install when they change, and that install rewrites the
lockfile while the deploy writes. A version keeps a lockfile only when Make's
client wrote it, so each lockfile is written through the client even when
Make's install already holds main's content, and its start content is backed
up first for `--abort` (unless it already equalled main's, so there is nothing to restore). After each dependency
write, and whenever Make's state moves under a write, the deploy waits until
Make is idle, checks that every unsaved path is planned and holds its before or
planned content (only a planned dependency file may hold what Make's install
regenerated), and tries that path again. Before the save, a dependency file
Make regenerated is written again; when Make keeps changing it after three
rounds, the deploy stops without saving. It then
saves one version `deploy <sha7>` whose saved tree must equal the checked working
tree (Make may list only planned paths as pending), checks the whole project
root against `main`, and pushes the annotated tag `make-deploy/<n>` on the
deployed commit. The tag message ends with the receipt's public JSON (no local
paths). `make status` and the next deploy take the tagged commit's tree as the
base; a receipt `mainTree` that differs from it is refused by deploy and flagged
by `make status` as `receiptMismatch`.

The receipt, `figma-cli/make-deploy-receipt@1` in `~/.figma-cli/deploys/`
(mode 0600), holds `deployId`, `who`, `at`, `repo`, `mainCommit`, `mainTree`,
`fileKey`, `makeBefore{versionGitSha,tree}`,
`makeAfter{versionId,versionNumber,versionGitSha,tree}`, `planDigest`,
`files[{path,op,beforeSha256,afterSha256,backupPath}]`, `excluded`, the `tag`,
the `stage`, `outcome` (`ok`, `uncertain` or `aborted`) and `verification`
(`saved-clean-tree-matched`, then `fresh-sandbox-verified`).

Recovery:

| Stopped at | `stage` | Run |
|---|---|---|
| A write, before any save (`DEPLOY_WRITE_FAILED`) | `writing` / `written` | `--resume` writes the remaining paths and saves; each planned path must hold its before or after content and nothing else may be unsaved; a planned dependency file Make's install regenerated, and a lockfile already holding main's content, is written again through the client. `--abort` restores the written paths from the backups instead, including a regenerated dependency file whose start content a backup holds; a lockfile that started equal to main stays as Make holds it |
| createVersion ran but was not confirmed (`DEPLOY_SAVE_UNCERTAIN`) | `save-uncertain` / `saved-unverified` | `--verify` only; the save is never retried |
| Saved, but the drift check could not read Make (`DEPLOY_DRIFT`) | `saved` | `--verify`; if Make has moved past the saved version, it records `saved-drift` |
| Saved, but Make does not equal `main` (`DEPLOY_DRIFT`) | `saved-drift` | Look at the listed paths; the next dry run plans from this version, or refuses as make-ahead when Make has moved past it |
| Tag number taken after the save | `tag-clash` | A new dry run plans from this version |
| Tag push failed | `tag-pending` | `--verify` pushes it, even when Make has changed since, because the save already passed the drift check |

`--verify` reloads the Make tab, requires Make's saved version and tree to be the
deploy's with nothing pending, adopts the version an unconfirmed save created,
pushes a missing tag and marks the receipt `fresh-sandbox-verified`. A warm match
right after the save is not proof that the version persists.

### Team git workflow (`team`)

`figma-cli team <verb>` is the plain-language git layer for designers working in
a team-mode project's local clone. The verbs hold all the git logic, so an
agent (skill `figma-make-team`) only maps words to a verb and explains the
result. They use your own `git` and `gh` logins, store no tokens and never read
or write Figma. Results are JSON on stdout with a plain-language `summary`;
errors are JSON on stderr with a `TEAM_*` `code`, exit 1. Every verb runs in
the clone, or takes `--dir <clone>`.

Hard rules, enforced in code (`src/make-team.js`): work happens only on your own
`<gh-login>/<slug>` branch (`TEAM_ON_MAIN`, `TEAM_NOT_YOUR_BRANCH`,
`TEAM_DETACHED`); every push names an explicit `refs/heads/<branch>` refspec,
never `main` (`TEAM_PUSH_REFUSED`); the only forced push is
`--force-with-lease=<ref>:<exact sha>` to your own branch; `main` is always
fetched and targeted explicitly; and a merge needs an approval from someone
other than the author. GitHub `main` stays unprotected, so this is the review
convention, not a server-side guarantee.

- `team start "<name>"` requires a clean tree (`TEAM_UNSAVED`; `--save-first`
  saves your own branch first, or carries changes made on `main` onto the new
  branch, running the secret, large-file, format and build checks before
  anything is created; if the save still fails after the branch exists, the
  error says the branch was started and whether the changes are still unsaved
  or saved on this computer only), fetches `main`, refuses local commits on `main` (`TEAM_MAIN_AHEAD`)
  and an existing branch (`TEAM_BRANCH_EXISTS`), creates `<login>/<slug>` from
  `origin/main`, fast-forwards the local `main` ref and pushes the branch with
  upstream. It lists the `areas` owners.
- `team save [-m msg]` lists changes in plain words, refuses secret-like files
  (`.npmrc`, `.env*` except `.env.example`/`.sample`/`.template`, private keys,
  `.netrc`) and token-looking content (GitHub, npm, Figma, AWS, Slack, API keys,
  registry `_authToken=`), reporting path and line only (`TEAM_SECRET`), and
  files over 50 MB (`TEAM_LARGE_FILE`). It then runs `package.json` `format`
  and `build` scripts when present (pnpm, or npm with only a `package-lock.json`;
  `TEAM_FORMAT_FAILED`/`TEAM_BUILD_FAILED` save nothing). Vendored files (every
  file in the folder of a `VENDOR.json`, and every file a `VENDOR.json` lists;
  a root `VENDOR.json` pins only what it lists) are read before the scripts and
  put back byte for byte, mode included, afterwards, also when a script fails,
  so a formatter never rewrites them; `vendoredKept`/`vendoredRestored` count
  them and a warning says when something was put back. It commits everything with
  your message or a generated one, and pushes. Changes in another person's
  area produce a warning. The push is plain: a GitHub branch with commits this
  clone lacks refuses (`TEAM_PUSH_REJECTED`, only for git's `stale info`,
  `non-fast-forward` and `fetch first`; the commit stays local and `team sync`
  brings that work in). A push GitHub's server refuses (`[remote rejected]`:
  push protection, pre-receive hooks, rulesets) is `TEAM_PUSH_BLOCKED` with
  GitHub's own `remote: error:` line. Because the flagged content would stay in
  an unsent commit, `save` and `sync` then undo your unsent commits with
  `git reset --soft` (back to GitHub's copy of your branch, or to where the
  branch left `main` when that is newer, as after a sync), keeping every change in
  the files; nothing GitHub already has, `main` or anyone else's branch is
  touched. Remove what GitHub flagged and save again. When that sync had
  rebased saves GitHub already has, their rebased copies are undone locally
  too (GitHub keeps the originals) and the message says to "get the latest"
  (`team sync`) instead, since a plain save would be refused as out of date.
- `team sync` commits locally (the same checks as `save`, no push), fetches
  your branch from GitHub and rebases local commits onto any newer saves there
  (commits already present in rewritten form, after an earlier sync whose push
  failed, are not replayed), then fetches `main`, rebases onto `origin/main` and
  pushes with `--force-with-lease` on the GitHub sha it brought in. Conflicts
  in either step are handled as below.
- `team conflicts` (also run by `sync`) resolves only `pnpm-lock.yaml` (takes
  `main`'s, then `pnpm install --lockfile-only --ignore-scripts`) and conflict
  blocks whose two sides are identical. Anything else runs `rebase --abort`,
  checks the branch is back at its old commit and reports `TEAM_CONFLICT` with
  `conflicts[{path, changedBy[{author, pr, commit}]}]`, taken from `gh api
  repos/<repo>/commits/<sha>/pulls` or the squash subject's `(#n)`. figma-cli
  always finishes or undoes its own rebases, so a rebase (or merge,
  cherry-pick, revert) already unfinished in the clone was started by something
  else: every verb that changes the branch refuses with
  `TEAM_OPERATION_IN_PROGRESS` and never continues, skips or pushes it.
- `team pr [--title]` syncs, saves, refuses a branch with no changes
  (`TEAM_NOTHING_TO_REVIEW`), then reuses the open pull request for the branch
  or runs `gh pr create --base main` with a short template: what changed (each
  file when there are at most 10, otherwise counts by kind and by top folder),
  who was asked to review, how to see it locally, a screenshot slot. It
  requests reviews from `areas` owners of the changed files, except you; a
  failed request only warns. When nobody is asked, `noReviewerRequested` and
  the summary say why (no `areas` map, no area covers the files, or you own
  them all). The result lists at most 10 `files`, with `fileCount`.
- `team merge` requires your own branch with no unsaved files, an open,
  non-draft pull request into `main` whose head equals your local and GitHub
  branch (`TEAM_OUT_OF_DATE`) and is not from a fork, no outstanding requested
  changes, and an approval of that exact head commit from someone who is
  neither the author nor you (`TEAM_NOT_APPROVED`; reviews are read from
  `gh api repos/<repo>/pulls/<n>/reviews`, whose `commit_id` gh's
  `latestReviews` leaves empty; an approval of an earlier commit is named as
  stale and does not count), a green build and a branch containing
  `origin/main`. When `main` moved, it syncs and refuses (`TEAM_BEHIND_MAIN`)
  so checks and review can run again. The green build is the pull request's
  GitHub checks (`TEAM_CHECKS_FAILED`/`TEAM_CHECKS_PENDING`); when it has none,
  the project's `build` script runs locally on the exact head being merged
  (`TEAM_BUILD_FAILED`), and with no `build` script either it refuses
  (`TEAM_NO_BUILD_CHECK`) unless `--no-build-check` is passed. Then `gh pr merge
  --squash --match-head-commit <sha>`, a check that GitHub reports `MERGED`,
  `main` checked out and fast-forwarded, and the branch deleted on GitHub (with
  a lease) and locally.
- `team merge --force --reason "<text>"` merges without the non-author approval,
  for repo admins only (`gh api repos/<repo>` `.permissions.admin`;
  `TEAM_FORCE_NOT_ADMIN`). The reason is required, 5 to 500 characters, and
  must not look like a token (`TEAM_FORCE_NO_REASON`; `--reason` without
  `--force` is refused the same way); `--no-build-check` is refused with it
  (`TEAM_FORCE_NEEDS_BUILD`). Every other check still applies: own branch, an
  open pull request at your exact head, no requested changes, a green build
  and an up-to-date branch. The squash commit's body says who force-merged and
  why, and a private receipt `figma-cli/team-force-merge@1` (repo, pull
  request, who, reason, head, merge commit, checks) is written to
  `~/.figma-cli/merge-receipts/` (mode 0600) and returned as `receipt`. A pull
  request that already has a current approval merges normally, with a warning.
  When GitHub's own protection on `main` requires an approving review, GitHub
  refuses the merge and figma-cli stops with `TEAM_FORCE_PROTECTED` and no
  receipt; force merge does not override it (no `--admin`), so ask a reviewer
  to approve.
- `team status [--no-fetch]` reports the branch, unsaved files, any unfinished
  rebase, commits behind and ahead of `main`, and the pull request's state,
  approvals, requested changes, pending reviewers and checks, with nudges
  (sync when `main` has been ahead for over a day).

**Cross-review** (`src/make-team-review.js`). A `<pr>` is a number, `#n`, a pull
request link of this repo, or the author's GitHub login when they have exactly
one open pull request (`TEAM_AMBIGUOUS` lists them otherwise;
`TEAM_PR_NOT_FOUND`). Only open (`TEAM_PR_CLOSED`), same-repo pull requests
into `main` are reviewed (`TEAM_PR_NOT_READY`).

- `team reviews` lists open, non-draft pull requests into `main` by someone
  else where you are a requested reviewer or your latest review is not of the
  current head (`needsReview`, requested first), the rest you reviewed, and
  your own open pull requests with their approvals and pending reviewers
  (`yours`).
- `team review <pr>` (your own pull request too, with a warning that someone
  else has to approve it) fetches its head (it must equal GitHub's `headRefOid`), and checks it out
  **detached** in a git worktree at `.figma-cli/reviews/pr-<n>` under the main
  clone. The copies stay out of the clone's saves through
  `.figma-cli/reviews/.gitignore` (`*`, which ignores itself too); the clone's
  shared `.git/info/exclude` is never written. It then
  installs with `make install` plus `--ignore-pnpmfile` (`pnpm install
  --frozen-lockfile --ignore-scripts --ignore-pnpmfile`, so none of the pull
  request's code runs; a failure only warns) and reports the files with +/- line
  counts (empty new or deleted files and mode-only changes included), the saves
  and the `make dev` command. A rerun moves the copy to the
  newer head, refusing when it has edits outside `.lavish/`
  (`TEAM_REVIEW_DIRTY`); `--remove` deletes it with `git worktree remove
  --force`. `--lavish` writes `.lavish/review/index.html` in the copy (every
  diff line an element with an `id` and `data-source="<file>:<line>"`) and
  `source-map.json` (id → file, line, side), plus the copy's `make start`
  design build at `.lavish/prototype/index.html` when present; then
  `lavish-axi <page>` for each (a missing `lavish-axi` only warns). When a page
  opened, the result carries `listen`: `{auto: true, commands: ["lavish-axi poll
  <page>", …], rule}`, and the CLI repeats it on stderr. The agent starts those
  polls at once as tracked background jobs and restarts them until the person
  ends the session (`src/lavish-listen.js`, skill `figma-make-team`), so the
  designer never turns listening on. The review page says what to type to the
  agent should Lavish ever show that nobody is listening. `--app`
  (implies `--lavish`) also runs `pnpm exec vite build --base ./` into
  `.lavish/review/app/` and inlines its entry script and stylesheets (Lavish's
  sandboxed frame blocks module loads). That runs the pull request's own build
  config on your computer, as `make dev` does, so it is never automatic; a
  failed build only warns.
- `team comment <pr> -m` posts a line comment (`gh api POST
  repos/<repo>/pulls/<n>/comments`, on the reviewed commit) when the target is
  a line inside the pull request's diff: `--file`/`--line` (`--old` for a
  removed line), a `--selector` whose last `#id` is in the review page's source
  map (only a map made for the commit being commented on; an older page's
  note becomes a general comment), or `--source file:line` read from an app
  element's `data-source` in Lavish's DOM snapshot. Anything else, including
  a line GitHub rejects, is a general comment (`issues/<n>/comments`) that
  quotes the target and any `--text` (`TEAM_BAD_COMMENT` for an empty message
  or half a target).
- `team approve <pr>` and `team request-changes <pr> -m` refuse your own pull
  request (`TEAM_SELF_REVIEW`) before calling GitHub, refuse approving a draft,
  and post a review (`gh api POST repos/<repo>/pulls/<n>/reviews`) as your own
  gh login with `commit_id` set to your review copy's commit, or GitHub's head
  with a warning when there is no copy. A copy older than GitHub's head is
  refused (`TEAM_REVIEW_OUTDATED`), so you approve only what you looked at.
  `team merge` still counts only approvals of the current head from someone
  other than the author.
- Every verb that commits, switches or pushes (`start`, `save`, `sync`,
  `conflicts`, `pr`, `merge`, `address`) refuses to run inside a review copy
  (`TEAM_REVIEW_COPY`), and the copy is detached, so a reviewer never pushes to
  the author's branch.
- `team feedback [pr]` (default: your current branch's pull request) shows
  current-head approvals, requested changes, and every review body, line
  comment (`path:line`, `outdated`) and general comment from someone other than
  the author. The author's own comments are not listed; `authorCommentsHidden`
  counts them and the summary says so, instead of "no comments" (`address`
  does the same).
- `team address [pr]` requires your own branch (`TEAM_NOT_YOUR_BRANCH`) and no
  unsaved files elsewhere (`TEAM_UNSAVED`), switches to it (creating it from
  GitHub's copy when missing), fast-forwards to GitHub's copy when that is
  only ahead, and returns the reviewers' comments as `todo`, with the next
  steps: make the changes, `team save`, `team sync`, ask for another look.

The repo comes from the `origin` GitHub URL, or from `repo` in
`.figma-cli/project.json` (they must agree). Its optional `areas` map names
owners per path glob (`**` crosses folders, `*` does not, a trailing `/` means
everything below):

```json
{ "fileKey": "…", "repo": "owner/repo", "trunk": "main",
  "areas": { "src/components/**": ["alice"], "src/index.css": ["bob"] } }
```

### Make delta and sync

`make export-delta` requires a clean saved git-mode Make file, a trusted
VENDOR.json baseline, an engineer identity and a new output path. It emits
`{schema,who,make,baselineManifestSha256,conflicts,files}`. Each file has a full Make
vendor path (`src/vendor/atomic-aui/<path>`), status (`added`, `changed`,
`deleted`, or `dependency`), before/after byte counts and SHA-256, and base64
bytes for present files. `--candidate-dir` holds the workspace copies at the same
full Make paths; each file records the `workspace` hash (null when absent) and
`conflict: true` when that copy also differs from the baseline. `conflicts` lists
those paths so intake resolves them in the reviewed workspace PR. Repeat `--dependency PATH` to include unchanged support
files explicitly. Workspace `atomic-cli intake-make-delta --from delta.json` consumes
its `files[].path` values. Generated tokens, sync metadata and kit scaffolding
cannot enter that delta. `--path` may be repeated to select an exact scope.

`make sync` consumes the output directory of workspace `atomic-cli
package-make-kit`, including `make-kit.manifest.json` and exact generated bytes.
The package does not contain its sibling `generated.manifest.json`; supply the
committed file with `--generation-manifest` for a token update. Its SHA-256 must
match the package's `generationManifest.sha256`. A component-only sync requires
the existing Make generated manifest and complete token tree to match the
package. The trusted VENDOR.json bytes must match Make's copy.

The request is JSON with schema `figma-cli/make-sync-request@1`, `fileKey`,
`requestId`, `requestedAt`, `who`, `direction` (`workspace-to-make`; Make
changes go through `make export-delta`, workspace `intake-make-delta` and a
reviewed workspace PR, so `make sync` refuses `make-to-workspace`), `workspaceCommit` (full package commit), `files`, and
`choices`. Each file records a full Make path, `baselineSha256` and
`workspaceSha256` (null means absent), and an explicit `dependencies` array of
other full paths in scope. Candidate component bytes are under `--candidate-dir`
at the same full Make paths; the request hash binds them. Example:

```json
{
  "schema": "figma-cli/make-sync-request@1",
  "fileKey": "EXACT_KEY",
  "requestId": "review-2026-10-13-1",
  "requestedAt": "2026-10-13T00:00:00.000Z",
  "who": "engineer@example.com",
  "direction": "workspace-to-make",
  "workspaceCommit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "files": [{
    "path": "src/vendor/atomic-aui/lib/Button.tsx",
    "baselineSha256": null,
    "workspaceSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "dependencies": []
  }],
  "choices": {}
}
```

Dry-run `--plan-out` writes a new private JSON plan with before/after hashes,
compact text diffs, conflict classes and a digest. If Make has destination-only
or two-sided edits, delete/edit, edit/delete, or same-path additions, the plan lists unresolved
paths. Resolve each via `choices[path]` as `{ "action": "override-make" }`,
`{ "action": "override-workspace" }`, `{ "action": "merged", "file":
"relative/path", "expectedSha256": "..." }`, or `{ "action": "stop" }`, then
make a new plan. There is no automatic winner. A token update deletes a Make
generated file that the package no longer has only when the request lists it
with `workspaceSha256: null`. Generated tokens only accept
Core package bytes. `override-workspace` records a workspace review handoff;
Make apply waits for a new committed workspace candidate. Out-of-scope Make
drift is shown in the plan and blocks apply so it cannot advance unrelated
baselines. An apply requires `--apply PLAN --receipt-out NEW_FILE` with
the same inputs. A changed plan digest, Make version, inventory, package, request
or candidate hash refuses before writes. Apply uses Make client VFS, exact
pending-path save and final drift. A partial write or uncertain save needs
inspection and reconciliation; do not replay it blindly. A recovery receipt
records completed writes and any known saved version when apply fails after
mutations begin. When the VENDOR.json write completed, it also writes
`<receipt>.VENDOR.json` and records its path and SHA-256; run `make drift` with
that file (otherwise the trusted baseline) as `--manifest` to read the saved
version and pending paths before reconciling. `--backup-dir` can keep replacement backups in a chosen private
directory. The success receipt records
identity, direction, scope, choices, before/after hashes, workspace commit and
Make version. Apply also writes the exact VENDOR.json bytes it wrote to Make
next to the receipt (`<receipt>.VENDOR.json`) and records `afterManifestPath` and
`afterManifestSha256`. Commit that file with the workspace sync; it is the next
trusted `--manifest`. A fresh sandbox reload remains the separate persistence check.

`read` returns the file in the open session's working copy and its SHA-256 as JSON, read through Make's
filesystem connection, so any listed text file works at any folder depth,
including Markdown that Make shows as a rendered preview. The result's `source`
is `filesystem`. Only when no filesystem connection can be observed does `read`
fall back to the open editor document (`source: "editor"`), which still needs the
file's whole folder chain to fit in the file-tree viewport. `--remote` requires
the filesystem connection and never falls back. With `--out`, source goes to a
new local file (an existing file is not overwritten), and stdout contains
metadata. `files` expands and scrolls the virtualized file tree so nested paths
and repeated basenames are resolved unambiguously; `read` and `replace` use that
listing to refuse paths that are not project files.
Each operation temporarily keeps the Make renderer active through CDP, allowing
its file tree to update while Figma is in the background, then clears that
override. It does not move operating-system focus. Editor selection (used by
`diagnostics` and the read fallback) verifies the entire parent-folder chain and
collapses unrelated folders so large vendor trees do not obscure an app file.
Paths whose ancestors and file still cannot fit together in the viewport are
refused by those editor commands.

`replace` works on any existing text file at any depth through the filesystem
connection. It reads the session's file and refuses unless its SHA-256 matches
`--expected-sha256`, saves a private local backup, then, in one page call,
re-reads the file, compares it with the backed-up bytes, and only then sends one
write. It checks Make's write reply (path and byte count) and reads the file back,
comparing it byte for byte. Successful results report
`verification: "session-readback-matched"`, `readback: "matched"` and
`persistence: "session-only"`. This confirms only that the session's working
copy holds the new bytes; it does not save the project (see above), and it does
not certify a passing app build, deployment, or publication. An unchanged
file reports `changed: false` and `persistence: "unverified"`. Replacement never
creates a file: a path missing from the project listing or from the session's
working copy is refused before any backup.

Backups default to `~/.figma-cli/make-backups`; override with `--backup-dir`.
Their source files and metadata use private filesystem permissions. Keep the
returned backup path until the intended change is reviewed.

Writes reject a stale hash, a running Make generation, a visible connection
warning, or a visible read-only editor. A change detected between the backup
and the write is refused with `outcome: "refused"` and no write sent. Writes
are never retried automatically. A timeout after a write may mean it reached the session:
read the file again before deciding what to do. To restore, read the current
hash and replace from the original backup with that hash. Do not blindly
replay a failed write or roll back over another person's changes.

Replacement files must be valid UTF-8 text, at most 2 MiB. Byte-order marks and
line endings are preserved when loading local source.

`--from -` and `--manifest -` read blocking stdin, so application source can stay
in memory and be written directly into the Make session without creating local app files.
Import manifests use `{ "files": [{ "path": "src/Component.tsx", "content": "..." }] }`.
`create` and `import` reject existing paths, case-ambiguous duplicates, traversal,
and file/folder conflicts. Limits: 300 files, 2 MiB each, 20 MiB total source.

Reading, replacement, creation, verification and removal use Make's observed
filesystem protocol on its existing authenticated WebSocket. Before each
operation starts focus emulation, the adapter arms a passive send hook. A
background Make page closes that socket while hidden and reconnects it when
focus emulation starts; the reconnect's `control/provision` message identifies
the socket and its workspace, which is usable once Make's
`control/workspace_create_ack` arrives. A Make request to read an uncached
source file also identifies it. If the socket stayed open since it provisioned
unobserved, the adapter closes it (never while Make is generating) so Make
reconnects and provisions under the hook; when nothing is captured, the command
fails with no write and suggests moving the tab to the background for a minute. The hook is restored after
capture. The adapter reuses the connection in the same Make page; it never
extracts credentials or opens a separate authenticated connection. The cached
socket reference expires with the page/socket. Each write's reply is checked and
the file read back, in the session only. This is an experimental private protocol, not a public Figma API.

Imports are sequential, not atomic. Errors report `sessionWrites` (files written in the session) and requested
paths; other writes may have an uncertain outcome. Inspect and verify before
resuming, and submit only missing files. `verify` compares the session's source bytes to
the manifest without changing files; a match does not prove the files were saved. `preview` inspects the current rendered app
and Vite overlay through the desktop connection; it does not reload or publish.

`remove <path> --expected-sha256 <hash>` is for explicitly authorized source cleanup.
It reads the exact remote file, checks its hash, writes a private recovery backup,
and requests removal of that file from the session's working copy only. It does not recursively remove folders.
Keep its backup until cleanup is reviewed. Like replacement, this check is not a
server-side compare-and-swap; do not run concurrent writers on the same project.

Limitations: no rename, binary edits, or multi-file atomic changes. Replacement's
final content check is one server round trip before the write, not a server-side
compare-and-swap against other collaborators. Whether an editor that already
shows the file refreshes after a filesystem write has not been verified live
(UNVERIFIED); read the file back rather than trusting the open editor. The
adapter depends on Make's observed filesystem messages and the current
CodeMirror editor (for `diagnostics` and the read fallback), so a Figma update
may require adapting it. It does not reload the
desktop page, restart Figma, trigger Make prompts, or publish the app.

## Design Tokens & Variables

### Create Design Systems

```bash
node src/index.js tokens ds              # IDS Base colors
node src/index.js tokens tailwind        # Tailwind 22 color families (242 vars)
node src/index.js tokens spacing         # Spacing tokens
```

### Manage Variables

```bash
node src/index.js var list               # Show all variables
node src/index.js var list -t COLOR      # Filter by type
node src/index.js var visualize          # Show colors on canvas
node src/index.js var create "name" -c "ColId" -t COLOR -v "#3b82f6"
```

### Bind Variables

```bash
node src/index.js bind fill "primary/500"
node src/index.js bind stroke "border/default"
node src/index.js bind radius "radius/md"
node src/index.js bind gap "spacing/md"
node src/index.js bind padding "spacing/lg"
node src/index.js bind list              # List available variables
```

## Create Elements

### Quick Primitives

```bash
node src/index.js create rect "Card" -w 320 -h 200 --fill "#fff" --radius 12
node src/index.js create circle "Avatar" -w 48 --fill "#3b82f6"
node src/index.js create text "Hello" -s 24 -c "#000" -w bold
node src/index.js create line -l 200 -c "#e4e4e7"
node src/index.js create autolayout "Card" -d col -g 16 -p 24 --fill "#fff"
node src/index.js create icon lucide:star -s 24 -c "#f59e0b"
node src/index.js create image "https://example.com/photo.png" -w 200
node src/index.js create group "Header"
node src/index.js create component "Button"
```

### Create with Variable Binding (Fast)

Use `var:name` syntax to bind shadcn variables at creation time:

```bash
node src/index.js create rect "Card" --fill "var:card" --stroke "var:border"
node src/index.js create circle "Avatar" --fill "var:primary"
node src/index.js create text "Hello" -c "var:foreground"
node src/index.js create line -c "var:border"
node src/index.js create frame "Section" --fill "var:background"
node src/index.js create autolayout "Container" --fill "var:muted"
node src/index.js create icon lucide:star -c "var:primary"
```

### Render with JSX

```bash
node src/index.js render '<Frame name="Card" w={320} h={180} bg="#fff" rounded={16} flex="col" gap={8} p={24}>
  <Text size={20} weight="bold" color="#111">Title</Text>
  <Text size={14} color="#666" w="fill">Description</Text>
</Frame>'
```

### Render with Variable Binding (Fast)

Use `var:name` syntax to bind shadcn variables at creation time (no separate bind commands needed):

```bash
node src/index.js render '<Frame name="Card" w={320} h={180} bg="var:card" stroke="var:border" rounded={16} flex="col" gap={8} p={24}>
  <Text size={20} weight="bold" color="var:foreground">Title</Text>
  <Text size={14} color="var:muted-foreground" w="fill">Description</Text>
  <Frame bg="var:primary" px={16} py={8} rounded={8}>
    <Text color="var:primary-foreground">Button</Text>
  </Frame>
</Frame>'
```

Variables: `background`, `foreground`, `card`, `primary`, `secondary`, `muted`, `accent`, `border`, and their `-foreground` variants.

### Render Batch (Multiple Frames)

```bash
node src/index.js render-batch '[
  "<Frame name=\"Card 1\" w={300} h={200} bg=\"#fff\"><Text>Card 1</Text></Frame>",
  "<Frame name=\"Card 2\" w={300} h={200} bg=\"#fff\"><Text>Card 2</Text></Frame>"
]' -d row -g 40
```

Options: `-d row|col` (direction), `-g <n>` (gap)

## Modify Elements

```bash
node src/index.js set fill "#3b82f6"           # Change fill (hex)
node src/index.js set fill "var:primary"       # Bind fill to variable (fast)
node src/index.js set fill "#3b82f6" -n "1:234" # On specific node
node src/index.js set stroke "#e4e4e7" -w 1    # Add stroke (hex)
node src/index.js set stroke "var:border"      # Bind stroke to variable
node src/index.js set radius 12                # Corner radius
node src/index.js set size 320 200             # Resize
node src/index.js set pos 100 100              # Move
node src/index.js set opacity 0.5              # Opacity
node src/index.js set autolayout row -g 8 -p 16 # Apply auto-layout
node src/index.js set name "Header"            # Rename
```

## Layout & Sizing

```bash
node src/index.js sizing hug                   # Hug contents
node src/index.js sizing fill                  # Fill container
node src/index.js sizing fixed 320 200         # Fixed size
node src/index.js padding 16                   # All sides
node src/index.js padding 16 24                # Vertical, horizontal
node src/index.js gap 16                       # Set gap
node src/index.js align center                 # Align items
```

## Find & Select

```bash
node src/index.js find "Button"                # Find by name
node src/index.js find "Card" -t FRAME         # Filter by type
node src/index.js select "1:234"               # Select node
node src/index.js get                          # Get selection props
node src/index.js get "1:234"                  # Get specific node
```

## Canvas Operations

```bash
node src/index.js canvas info                  # What's on canvas
node src/index.js canvas next                  # Next free position
node src/index.js arrange -g 100               # Arrange frames
node src/index.js arrange -g 100 -c 3          # 3 columns
```

## Duplicate & Delete

```bash
node src/index.js duplicate                    # Duplicate selection
node src/index.js dup "1:234" --offset 50      # With offset
node src/index.js delete                       # Delete selection
node src/index.js delete "1:234"               # Delete by ID
```

## Node Operations

```bash
node src/index.js node tree                    # Show tree structure
node src/index.js node tree "1:234" -d 5       # Deeper depth
node src/index.js node bindings                # Show variable bindings
node src/index.js node to-component "1:234"    # Convert to component
node src/index.js node delete "1:234"          # Delete by ID
```

## Slots

Figma's native slots feature for flexible content areas in components.

```bash
node src/index.js slot create "Content"        # Create slot on component
node src/index.js slot create "Actions" --flex row --gap 8 --padding 16
node src/index.js slot list                    # List slots in component
node src/index.js slot list "1:234"            # List by component ID
node src/index.js slot preferred "Slot#1:2" "comp-id-1" "comp-id-2"  # Set preferred
node src/index.js slot reset                   # Reset slot to defaults
node src/index.js slot add "slot-id" --component "comp-id"  # Add to slot
node src/index.js slot add "slot-id" --frame   # Add empty frame
node src/index.js slot add "slot-id" --text "Hello"  # Add text
```

## Export

```bash
node src/index.js export css                   # Variables as CSS
node src/index.js export tailwind              # Tailwind config
node src/index.js export screenshot -o out.png # Screenshot (selection or page)
node src/index.js export screenshot -s 2 -f png # 2x scale PNG
node src/index.js export screenshot -f svg     # SVG format
node src/index.js export node "1:234" -o card.png         # Export node by ID
node src/index.js export node "1:234" -s 2 -f png         # 2x scale PNG
node src/index.js export node "1:234" -f svg -o card.svg  # SVG export
node src/index.js export-jsx "1:234"           # Export as JSX
node src/index.js export-jsx "1:234" -o Card.jsx --pretty
node src/index.js export-storybook "1:234"     # Storybook stories
```

## Analysis & Linting

```bash
node src/index.js lint                         # Check all rules
node src/index.js lint --fix                   # Auto-fix
node src/index.js lint --rule color-contrast   # Specific rule
node src/index.js lint --preset accessibility  # Use preset
node src/index.js analyze colors               # Color usage
node src/index.js analyze typography           # Typography
node src/index.js analyze spacing              # Spacing
node src/index.js analyze clusters             # Find patterns
```

Lint rules: `no-default-names`, `no-deeply-nested`, `no-empty-frames`, `prefer-auto-layout`, `no-hardcoded-colors`, `color-contrast`, `touch-target-size`, `min-text-size`

Presets: `recommended`, `strict`, `accessibility`, `design-system`

## XPath Queries

```bash
node src/index.js raw query "//FRAME"
node src/index.js raw query "//COMPONENT"
node src/index.js raw query "//*[contains(@name, 'Button')]"
node src/index.js raw select "1:234"
node src/index.js raw export "1:234" --scale 2
```

## Website Recreation

```bash
node src/index.js recreate-url "https://example.com" --name "My Page"
node src/index.js recreate-url "https://example.com" -w 375 -h 812  # Mobile
node src/index.js analyze-url "https://example.com" --screenshot
node src/index.js screenshot-url "https://example.com" --full
```

## Images

```bash
node src/index.js create image "https://example.com/photo.png"
node src/index.js screenshot-url "https://example.com"
node src/index.js remove-bg                    # Remove background (needs API key)
```

## FigJam

```bash
node src/index.js fj list                      # List pages
node src/index.js fj sticky "Text" -x 100 -y 100 --color "#FEF08A"
node src/index.js fj shape "Label" -x 200 -y 100 -w 200 -h 100
node src/index.js fj connect "ID1" "ID2"       # Connect elements
node src/index.js fj nodes                     # Show elements
node src/index.js fj delete "ID"
node src/index.js fj eval "figma.currentPage.children.length"
```

Shape types: `ROUNDED_RECTANGLE`, `RECTANGLE`, `ELLIPSE`, `DIAMOND`, `TRIANGLE_UP`, `TRIANGLE_DOWN`, `PARALLELOGRAM_RIGHT`, `PARALLELOGRAM_LEFT`

## Daemon & Connection

```bash
node src/index.js connect                  # Connect (Yolo Mode)
node src/index.js connect --safe           # Connect (Safe Mode, plugin)
node src/index.js daemon status            # Check daemon status
node src/index.js daemon status --debug    # Detailed token & connection info
node src/index.js daemon diagnose          # Full diagnostic (troubleshooting)
node src/index.js daemon start             # Start daemon manually
node src/index.js daemon start --force     # Force restart
node src/index.js daemon restart           # Restart with fresh token
node src/index.js daemon stop              # Stop daemon
node src/index.js daemon reconnect         # Reconnect to Figma
node src/index.js files                    # List open Figma files (JSON)
```

### Troubleshooting Auth Errors

If you see "Unauthorized: Invalid or missing token":

```bash
node src/index.js daemon diagnose          # See what's wrong
node src/index.js daemon restart           # Usually fixes it
```

Token file location: `~/.figma-ds-cli/.daemon-token`

## Component Combinations (combos)

Generate all variant combinations as individual components:

```bash
node src/index.js combos                   # Use selection
node src/index.js combos "1:234"           # By node ID
node src/index.js combos --dry-run         # Preview without creating
node src/index.js combos --gap 60          # Custom gap between components
node src/index.js combos --no-boolean      # Exclude boolean properties
```

**How it works:**
1. Select a component set (or any variant/instance)
2. Run `combos` to generate all combinations
3. Creates **individual components** directly on canvas (no container frame)
4. Each component named: `Button/Small/Default`, `Button/Small/Hover`, etc.
5. Arranged in a grid (last property = columns, rest = rows)
6. Row/column labels added automatically (use `--no-labels` to skip)

## Size Variants (sizes)

Generate Small/Medium/Large variants from a single component:

```bash
node src/index.js sizes                       # Use selection
node src/index.js sizes "1:234"               # By node ID
node src/index.js sizes --base small          # Source is Small size
node src/index.js sizes --base large          # Source is Large size
node src/index.js sizes --gap 60              # Custom gap
```

**How it works:**
1. Select a component or frame
2. Run `sizes --base <size>` to specify which size it is
3. Creates Small, Medium, Large variants with proportional scaling
4. Scales: dimensions, font sizes, padding, corner radius, gaps

## JavaScript Eval

```bash
node src/index.js eval "figma.currentPage.name"
node src/index.js eval --file /tmp/script.js
node src/index.js run /tmp/script.js
```

## Eval Helpers

Available inside every `figma-cli eval` (and used by `render`). They install on
first use and handle lazy pages, missing fonts and name lookups:

```js
const p = await $page('Scratch');                 // switch to page, create if missing
const v = await $var('bgColor/muted');            // local variable by full name
await $bind(frame, 'bgColor/muted');              // bind to fills ('strokes' or a field as 3rd arg)
const s = await $style('Body/Medium');            // any local style by name
const set = await $component('Button');           // component or set by name/id, whole file
const i = await $instance('Button', 'variant=danger, size=large', { text: 'Delete', parent: frame });
await $fontSafe(node);                            // load fonts, swap missing ones to Inter
return await $describe(node);                     // compact one-line-per-node summary
```

Piped output (an agent calling the CLI) is compact JSON and capped at 20,000
characters; a terminal still gets indented JSON.

## Render JSX Syntax

**Pages and design-system hooks**

```bash
figma-cli render --page "Scratch" '<Frame ...>'      # render-batch takes --page too
```
```jsx
<Instance component="Button" variant="variant=danger, size=large" text="Delete" />  // any page, font-safe
<Frame effectStyle="shadow/resting/small">...</Frame>
<Text textStyle="Body/Medium">...</Text>   // style's font missing: size/spacing kept on the fallback font
<Frame pt={4} pr={8} pb={4} pl={8}>        // per-side padding, root frames included
```

**Component sets in one call**

```bash
figma-cli render-batch '["<Frame name=\"size=small, state=default\" ...>...</Frame>", ...]' --variant-set Button
```
Frame names must be `prop=value, prop=value` with the same properties on every
frame; the command validates names before touching the file.


**Elements:** `<Frame>`, `<Rectangle>`, `<Ellipse>`, `<Text>`, `<Line>`, `<Image>`, `<SVG>`, `<Icon>`

**Size:** `w={320} h={200}`, `w="fill"`, `minW={100} maxW={500}`

**Layout:** `flex="row|col"`, `gap={16}`, `wrap={true}`, `justify="start|center|end|between"`, `items="start|center|end"`

**Padding:** `p={24}`, `px={16} py={8}`, `pt={8} pr={16} pb={8} pl={16}`

**Appearance:** `bg="#fff"`, `stroke="#000"`, `strokeWidth={1}`, `opacity={0.5}`

**Corners:** `rounded={16}`, `roundedTL={8}`, `overflow="hidden"`

**Effects:** `shadow="0 4 12 #0001"`, `blur={10}`, `rotate={45}`

**Native effects:** `noise="mono|duo|multi"` (grain), `texture={true}` (paper grain), `progressiveBlur={40}` (`progressiveBlurDir=down|up|left|right`), `glass={true}` (liquid glass: `glassRefraction`/`glassDepth`/`glassRadius`/`glassDispersion`/`glassLight`/`glassLightAngle`). Wallpapers: `gradient mesh "<colors>" --grain|--texture`.

### `<Text>` sizing and inline styling

- **Wrapping:** `w="fill"` fills the parent; a **numeric** `w={480}` sets a fixed
  width and wraps (works inside `flex="row"`, not just columns).
- **Inline runs:** style words inside one `<Text>` — `<b>`/`<strong>` (bold),
  `<em>`/`<i>` (italic), `<u>` (underline), and `<span weight= italic= color= size=
  letterSpacing=>` for arbitrary overrides. Runs inherit the base `<Text>` style;
  span attrs override. Run `color` is hex only.
- **HTML entities:** numeric (`&#8250;`, `&#x203A;`) and common named entities
  (`&amp; &lt; &gt; &rarr; &times; &hellip; &mdash; &nbsp;` …) are decoded.
- **Whitespace:** runs of spaces/newlines in `<Text>` content collapse to a single space (outer whitespace trimmed), so you can indent multi-line content freely.

```jsx
<Text size={28} w={620} color="#9E9EA0">
  An MCP server loads every tool, <b>confidently</b> wrong, while
  <span color="#FAFAFA" weight="bold">figma-cli</span> keeps memory empty.
</Text>
```

**Other Text props:** `font="Inter"`, `size={18}`, `weight="bold"` (thin..black), `italic={true}`, `color="#000"` (hex); missing fonts fall back to Inter.

**Undo:** `figma-cli undo` removes the node(s) created by the last render / render-batch.

**Verify in one call:** `figma-cli render '<Frame>...' --verify` (also on render-batch) returns a screenshot JSON of the result.

**WRONG vs RIGHT:**
```
layout="horizontal"  →  flex="row"
padding={24}         →  p={24}
fill="#fff"          →  bg="#fff"
cornerRadius={12}    →  rounded={12}
```

## Advanced Examples

### Switch to Dark Mode
```javascript
node src/index.js eval "
const node = figma.getNodeById('1:234');
function findModeCollection(n) {
  if (n.boundVariables) {
    for (const [prop, binding] of Object.entries(n.boundVariables)) {
      const b = Array.isArray(binding) ? binding[0] : binding;
      if (b && b.id) {
        const variable = figma.variables.getVariableById(b.id);
        if (variable) {
          const col = figma.variables.getVariableCollectionById(variable.variableCollectionId);
          if (col && col.modes.length > 1) return { col, modes: col.modes };
        }
      }
    }
  }
  if (n.children) {
    for (const c of n.children) {
      const found = findModeCollection(c);
      if (found) return found;
    }
  }
  return null;
}
const found = findModeCollection(node);
if (found) {
  const darkMode = found.modes.find(m => m.name.includes('Dark'));
  if (darkMode) node.setExplicitVariableModeForCollection(found.col, darkMode.modeId);
}
"
```

### Create Component Instance
```javascript
node src/index.js eval "(function() {
  const comp = figma.currentPage.findOne(n => n.type === 'COMPONENT' && n.name === 'Button');
  if (!comp) return 'Component not found';
  const instance = comp.createInstance();
  instance.x = 100;
  instance.y = 100;
  return instance.id;
})()"
```

### Smart Positioning
```javascript
let smartX = 0;
figma.currentPage.children.forEach(n => { smartX = Math.max(smartX, n.x + n.width); });
smartX += 100;
const frame = figma.createFrame();
frame.x = smartX;
```

## Safe Mode

Safe Mode uses a plugin-based connection instead of CDP (Chrome DevTools Protocol). Use it when:
- Company MacBook with restricted privacy settings
- Full Disk Access permission not available
- Prefer no Figma modification

### Connection
```bash
node src/index.js connect --safe
```

Then in Figma: Plugins → Development → FigCli

### Differences from Yolo Mode

| Feature | Yolo Mode | Safe Mode |
|---------|-----------|-----------|
| Connection | Direct CDP | Plugin bridge |
| Setup | Patches Figma once | Start plugin each session |
| Speed | ~10x faster | Standard |
| Timeout | 60 seconds | 60 seconds |

### Command Support

All commands work in both modes. In Safe Mode, commands use native Figma API instead of figma-use:

| Command | Yolo Mode | Safe Mode |
|---------|-----------|-----------|
| `render` | figma-use | daemon (native API) |
| `render-batch` | figma-use | daemon (native API) |
| `node to-component` | figma-use | native API |
| `node delete` | figma-use | native API |
| `node tree` | figma-use | native API |
| `node bindings` | figma-use | native API |
| `lint` | figma-use | native API |
| `analyze colors/typography/spacing/clusters` | figma-use | native API |
| `export-jsx` | figma-use | native API |
| `export-storybook` | figma-use | native API |
| All other commands | daemon | daemon |

### Tips for Safe Mode

1. **Keep payloads smaller**: Break complex screens into multiple `render` calls
2. **All commands work**: Native implementations match figma-use functionality
3. **Timeout**: Both modes now have 60s timeout

### When render-batch fails

If `render-batch` times out with complex JSX, break it up:

```bash
# Instead of one large batch
node src/index.js render-batch '[huge array]'

# Use multiple smaller batches
node src/index.js render '<Frame>...</Frame>'
node src/index.js render '<Frame>...</Frame>'
```

Or use `eval` with native Figma API for maximum control (see below).

## Safe Mode Component Creation

`render` and `render-batch` both work for components with text in Safe Mode — fonts are loaded automatically and characters set correctly. The native-API recipe below is only needed when you want fine-grained control over things JSX doesn't expose (e.g. mixed text styling, multi-stop gradients applied programmatically).

```javascript
node src/index.js eval "(async () => {
  // 1. Load fonts FIRST
  await figma.loadFontAsync({ family: 'Inter', style: 'Bold' });
  await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });

  // 2. Create frame with FIXED width
  const card = figma.createFrame();
  card.name = 'Card';
  card.x = 100; card.y = 100;
  card.resize(340, 1); // Fixed width!
  card.layoutMode = 'HORIZONTAL';
  card.primaryAxisSizingMode = 'FIXED';
  card.counterAxisSizingMode = 'AUTO';
  card.paddingTop = card.paddingBottom = card.paddingLeft = card.paddingRight = 20;
  card.itemSpacing = 16;
  card.cornerRadius = 12;
  card.fills = [{ type: 'SOLID', color: { r: 0.094, g: 0.094, b: 0.106 } }];

  // 3. Content frame must FILL remaining space
  const content = figma.createFrame();
  content.fills = [];
  content.layoutMode = 'VERTICAL';
  content.itemSpacing = 4;
  card.appendChild(content);
  content.layoutSizingHorizontal = 'FILL'; // Critical!

  // 4. Text must FILL to wrap
  const title = figma.createText();
  title.fontName = { family: 'Inter', style: 'Bold' };
  title.characters = 'Title here';
  title.fontSize = 14;
  title.fills = [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
  content.appendChild(title);
  title.layoutSizingHorizontal = 'FILL'; // Critical!

  // 5. Convert to component
  const comp = figma.createComponentFromNode(card);
  return { id: comp.id, name: comp.name };
})()"
```

**Auto-Layout Rules (Text Cut-Off Prevention):**
1. Parent frame needs `resize(WIDTH, 1)` + `primaryAxisSizingMode = 'FIXED'`
2. Child content frames need `layoutSizingHorizontal = 'FILL'` AFTER appendChild
3. ALL text nodes need `layoutSizingHorizontal = 'FILL'` AFTER appendChild
4. Order matters: appendChild first, then set layoutSizingHorizontal

## Complex Components (Pricing Cards, etc.)

For complex multi-element components, use a **single eval** with native Figma API instead of JSX:

### Pattern
1. **Check for variables first** - don't assume any collection exists
2. **Use fallback colors** when no variables present
3. **Single eval** - create everything in one API call
4. **Data-driven** - define content in array, loop to create
5. **Equal height** - use `layoutAlign: "STRETCH"` and `layoutGrow: 1`

### Fallback Colors (Dark Theme)
```javascript
const colors = {
  bg: { r: 0.09, g: 0.09, b: 0.11 },       // #17171c
  card: { r: 0.11, g: 0.11, b: 0.13 },     // #1c1c21
  border: { r: 0.2, g: 0.2, b: 0.22 },     // #333338
  primary: { r: 0.23, g: 0.51, b: 0.97 },  // #3b82f8
  text: { r: 0.98, g: 0.98, b: 0.98 },     // #fafafa
  muted: { r: 0.6, g: 0.6, b: 0.65 },      // #999aa6
  white: { r: 1, g: 1, b: 1 }
};
```

### Variable Detection
```javascript
const collections = await figma.variables.getLocalVariableCollectionsAsync();
if (collections.length > 0) {
  // Ask user which collection to use
} else {
  // Use fallback colors
}
```

### Equal Height Cards
```javascript
for (const card of container.children) {
  card.layoutAlign = 'STRETCH';
  card.primaryAxisSizingMode = 'FIXED';
  for (const child of card.children) {
    if (child.name === 'Features') {
      child.layoutGrow = 1;
    }
  }
}
```

### Button Component Pattern (for variants)
```javascript
frame.layoutMode = "HORIZONTAL";
frame.primaryAxisSizingMode = "FIXED";
frame.counterAxisSizingMode = "FIXED";
frame.resize(100, 40);
frame.primaryAxisAlignItems = "CENTER";
frame.counterAxisAlignItems = "CENTER";
frame.paddingLeft = frame.paddingRight = 16;
frame.paddingTop = frame.paddingBottom = 10;

text.textAlignHorizontal = "CENTER";
text.layoutAlign = "STRETCH";
text.layoutGrow = 1;
```

### Check Positions Before Creating
```javascript
const nodes = figma.currentPage.children.map(n => ({
  name: n.name, x: n.x, width: n.width
}));
const maxX = Math.max(0, ...nodes.map(n => n.x + n.width)) + 100;
```

## Layout Patterns

### Badge at avatar corner
```jsx
// Absolute x/y is relative to parent padding
// Avatar at padding=24, size=100, badge=20
// Position: padding + avatarSize - badgeSize/2 = 24 + 100 - 10 = 114
<Frame p={24}>
  <Frame w={100} h={100} rounded={50} />
  <Frame name="Badge" w={20} h={20} position="absolute" x={114} y={114} />
</Frame>
```

### Input at bottom (chat pattern)
```jsx
<Frame flex="col" h={400}>
  <Frame>Message 1</Frame>
  <Frame grow={1} />
  <Frame>Input field</Frame>
</Frame>
```

### Avoid content overflow
```jsx
// BAD: fixed height too small for auto-sized children
<Frame h={160} p={24}><Frame h={139} /></Frame>  // 139+48 > 160!

// GOOD: ensure height fits content + padding
<Frame h={200} p={24}><Frame h={139} /></Frame>  // 139+48 < 200 ✓
```

## Creating Webpages

Create ONE parent frame with vertical auto-layout containing all sections:

```bash
node src/index.js render '<Frame name="Landing Page" w={1440} flex="col" bg="#0a0a0f">
  <Frame name="Hero" w="fill" h={800} flex="col" justify="center" items="center" gap={24} p={80}>
    <Text size={64} weight="bold" color="#fff">Headline</Text>
    <Frame bg="#3b82f6" px={32} py={16} rounded={8}><Text color="#fff">CTA</Text></Frame>
  </Frame>
  <Frame name="Features" w="fill" flex="row" gap={40} p={80} bg="#111">
    <Frame flex="col" gap={12} grow={1}><Text size={24} weight="bold" color="#fff">Feature 1</Text></Frame>
  </Frame>
</Frame>'
```

## Slot Details

### JSX Slot Syntax

Use `<Slot>` in JSX. When parent is a component, creates real SLOT. Otherwise falls back to frame.

**Slot props:** `name`, `flex`, `gap`, `p`/`px`/`py`, `w`/`h`, `bg`

### Slot Workflow

1. Render component with `<Slot>`, then `node to-component "frame-id"`
2. Or add to existing: `slot create "Content" --flex col --gap 8`
3. Set preferred: `slot preferred "Slot#1:2" "comp-id-1" "comp-id-2"`

**In instances, slots allow:** Adding content, reordering, removing, reset to defaults.
