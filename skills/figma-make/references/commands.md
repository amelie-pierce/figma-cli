# Command and transfer patterns

Use the workspace's resolved launcher instead of the literal `figma-cli` below
when one is specified. Always supply the exact Make file key or URL to `--file`.
These examples are templates; choose paths/content for the actual requested work.

| Purpose | Command |
| --- | --- |
| Discover open projects | `figma-cli make list` |
| Check readiness | `figma-cli make inspect --file KEY` |
| Diagnose workspace controls without selecting tabs or reading source | `figma-cli make ui --file KEY` |
| Inventory source | `figma-cli make files --file KEY` |
| Read session source and hash (any depth, Markdown too) | `figma-cli make read src/App.tsx --file KEY` |
| Read installed kit source, never the editor buffer | `figma-cli make read node_modules/kit/AGENTS.md --remote --file KEY` |
| Create a new module (session-only) | `figma-cli make create src/Component.tsx --file KEY --from - --session-only` |
| Import new modules (session-only) | `figma-cli make import --file KEY --manifest - --timeout 120000 --session-only` |
| Replace existing source (session-only) | `figma-cli make replace src/App.tsx --file KEY --from - --expected-sha256 HASH --session-only` |
| Write existing source through Make VFS (git mode) | `figma-cli make write src/App.tsx --file KEY --from - --expected-sha256 HASH` |
| Write new source through Make VFS (git mode) | `figma-cli make write src/New.ts --file KEY --from -` |
| Delete source through Make VFS (git mode) | `figma-cli make delete src/Old.ts --file KEY --expected-sha256 HASH` |
| Save exact pending files as a Make version (git mode) | `figma-cli make save-version --file KEY --title "Reviewed edit" --expected-path src/App.tsx --expected-path src/New.ts --receipt-out receipt.json` |
| Create the first version of a never-saved git-mode file | `figma-cli make write src/New.ts --file KEY --from - --first-version`, then `figma-cli make save-version --file KEY --first-version --since HEAD_FROM_STATUS --title "First version" --expected-path src/New.ts` |
| Verify expected session content | `figma-cli make verify --file KEY --manifest - --timeout 120000` |
| Read project status: tree SHAs, solo/team mode, GitHub main, unreviewed commits, Push safety | `figma-cli make status --file KEY [--repo OWNER/REPO] --json` |
| Turn team mode on (writes and saves only the marker) | `figma-cli make mode team --file KEY --repo OWNER/REPO [--first-version] [--dry-run]` |
| Turn team mode off (repo admins; shows a warning) | `figma-cli make mode solo --file KEY --yes-turn-off-team-mode [--dry-run]` |
| Clone a team-mode repo at `main` and install it (frozen lockfile, `--ignore-scripts`) | `figma-cli make clone OWNER/REPO [dir]` or `figma-cli make clone --file KEY [dir]` |
| Install a clone again after its checks | `figma-cli make install [dir]` |
| Fast-forward `main` only; reinstall when the lockfile changed | `figma-cli make pull [dir]` |
| Start the dev server and print its local URL (agents: background job, then poll the URL) | `figma-cli make dev [dir]` |
| Start a task branch `<login>/<slug>` from the latest `main` (see the figma-make-team skill) | `figma-cli team start "task name" [--save-first]` |
| Save (format, build, secret check), commit and push your task branch | `figma-cli team save [-m "message"]` |
| Bring in the latest `main`; finish or undo a conflicted one | `figma-cli team sync` / `figma-cli team conflicts` |
| Open the pull request into `main`; merge it after a non-author approval | `figma-cli team pr` / `figma-cli team merge` |
| Branch, unsaved files, review state, distance from `main` | `figma-cli team status` |
| Check vendor drift and saved state, including hidden files | `figma-cli make drift --file KEY --manifest VENDOR.json --json` |
| Export a clean Make component delta for workspace intake | `figma-cli make export-delta --file KEY --manifest VENDOR.json --who NAME --candidate-dir candidates --out delta.json [--dependency PATH]` |
| Review an explicit workspace package sync | `figma-cli make sync --file KEY --package kit-package --manifest VENDOR.json --request request.json --candidate-dir candidates --plan-out plan.json` |
| Apply the unchanged reviewed sync plan | `figma-cli make sync --file KEY --package kit-package --manifest VENDOR.json --request request.json --candidate-dir candidates --apply plan.json --receipt-out receipt.json` |
| Inspect the running preview | `figma-cli make preview --file KEY` |
| Read source editor diagnostics | `figma-cli make diagnostics src/App.tsx --file KEY` |

Read commands return `{fileKey,path,content,sha256,source}`. `--out` is optional and writes
a local source copy; omit it in a direct-to-Make/no-local-app-code workflow.
`--from -` and `--manifest -` accept blocking stdin, including large source payloads.
No special stdin preloader or temporary source file is needed.

The four original write commands need `--session-only`; without it the CLI refuses before
connecting (`code: "MAKE_SESSION_ONLY_REQUIRED"`). Writes change only the open
session's working copy and are lost when the file is reopened unless the user
saves them in Make, which creates a new version through the file's saving mode.
Git-mode `write` and `delete` use Make's client VFS. They check the prior hash,
back up replaced or removed bytes, and verify the editor, tree, VFS and sandbox.
Markdown has no Make editor, so its writes are verified by tree, VFS and sandbox
(`verification: "tree-vfs-sandbox-matched"`). A new file directly under the
project root, or in a new top-level folder, is refused before writing.
They remain pending until `save-version` receives the complete changed-path set,
creates a Make version and confirms a clean pending state. Root `AGENTS.md` and
`CLAUDE.md` belong in that set when changed, although Make does not list them;
the result's `unlistedFiles` records their post-save hashes. Snapshot mode is
refused. After an uncertain result, inspect state before retrying. Reload the
exact Make tab and compare hashes plus `make drift` to prove persistence.
A git-mode file with no saved version is refused unless `--first-version` is
passed. Make lists no pending files before the first version, so
`save-version --first-version --since COMMIT` compares the working copy with the
sandbox commit `make status` reported before the writes, requires the expected
paths to equal that difference, and checks that the saved tree equals the
working tree. The flag is refused once the file has a version.
Every write, the session-only `replace`, `create`, `import` and `remove`
included, first reads `.figma-cli/project.json`. In team mode it refuses
(`MAKE_TEAM_MODE`): the file deploys from its repo, so tell the user to start a
task there instead of editing Make. When a repo is known (`--repo`, or a link
recorded locally by a prior `make status --repo`) and there is no marker, the
mode is ambiguous and writes refuse unless the user confirms `--solo`.
Run `make status` (exit 0 clean, 1 unreadable, 2 attention) to see the mode first.
Only `make mode team|solo` adds or removes the marker (`MAKE_MARKER_RESERVED`
for any other command). It refuses when other paths are pending or unsaved,
saves the marker change as its own version, reloads the tab to verify it, and
writes a receipt to `~/.figma-cli/mode-receipts/`.
To work on a team-mode project locally, `make clone` clones GitHub `main` with
the user's own `gh` login and installs it with pnpm (`pnpm install --frozen-lockfile
--ignore-scripts`; it refuses a repo without `pnpm-lock.yaml`). It refuses a `@make-kits/*`
dependency (`MAKE_KIT_DEPENDENCY`; vendor the kit by pull request instead),
warns on a committed `.npmrc` credential and never copies Make's `.npmrc`.
`make pull` refuses local commits on `main` (`MAKE_PULL_LOCAL_COMMITS`) and
uncommitted tracked changes on it (`MAKE_PULL_DIRTY`). `make dev` never returns
while the server runs: start it in the background and poll the printed URL.
`make sync` enforces this sequence for explicitly scoped workspace changes;
its plan and receipt stay outside the Make source tree. See the
[sync contract](../../../REFERENCE.md#make-delta-and-sync) for request
schema, Core token gate and conflict choices.

`read` returns the session's UTF-8 source through the observed filesystem connection,
at any folder depth and including Markdown that Make shows as a preview, without
changing the file (`source: "filesystem"`). Only when that connection cannot be
observed does it fall back to the open editor (`source: "editor"`), which refuses
paths whose folder chain cannot fit in the file-tree viewport. Pass `--remote` to
require the filesystem connection, and to inspect an attached kit under
`node_modules/`. Project paths must appear in the source inventory; installed
package paths under `node_modules/` may be hidden from that inventory.
`replace` hashes the same session content, so use the hash from a filesystem read.

## Transfer source safely

Build JSON with a serializer. Use Node's process API with an argument array and
stdin, keeping `shell: false`. This invokes the JavaScript entry point directly,
so it does not depend on Bash, CMD, PowerShell, Python, or a shell launcher.
Set the runner's working directory to the installed package root, or resolve the
entry point from a local dependency as described in the README. Preserve the
workspace's configured Figma port and other required environment settings.

```js
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const cliEntry = resolve('src/index.js'); // Working directory: CLI package root.
const key = 'EXACT_MAKE_FILE_KEY';
const port = process.env.FIGMA_PORT || '9333'; // Use the configured Figma port.

function runMake(args, input) {
  const result = spawnSync(process.execPath, [
    cliEntry, '--port', port, 'make', ...args, '--file', key,
  ], {
    shell: false,
    encoding: 'utf8',
    env: process.env,
    input,
    timeout: 135000,
    maxBuffer: 64 * 1024 * 1024,
  });
  // Preserve partial session writes and backup information, including on error.
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) {
    if (result.stdout) process.stderr.write(result.stdout);
    throw result.error || new Error(`CLI exited with ${result.status}`);
  }
  return JSON.parse(result.stdout);
}

const original = runMake(['read', 'src/App.tsx']);
// Prepare newSource in memory from original.content and the requested change.
// Only add required imports after their modules have been created.
// Session-only: the user must save the change in Make to keep it.
const written = runMake([
  'replace', 'src/App.tsx', '--from', '-',
  '--expected-sha256', original.sha256, '--session-only',
], newSource);
console.log(written); // Retain the returned backup path.

const verification = runMake([
  'verify', '--manifest', '-', '--timeout', '120000',
], JSON.stringify({ files: [{ path: 'src/App.tsx', content: newSource }] }));
console.log(verification);
```

Use the same manifest shape for `import` and `verify`:

```json
{
  "files": [
    {
      "path": "src/components/Example.tsx",
      "content": "export function Example() {\n  return <button>Example</button>;\n}\n"
    }
  ]
}
```

Import paths are project-relative, including the single `src/` prefix where
appropriate. Do not strip it or add another `src/`. The CLI handles nested paths;
do not route source imports through Make's upload UI.

Create/import reject existing files or folders, duplicate/case-ambiguous names,
path traversal, and file/folder conflicts. Each file must be valid UTF-8 text,
at most 2 MiB; a batch allows 1–300 files and at most 20 MiB of source. The serialized
manifest must be at most 32 MiB. Split larger work into intentional batches and
verify each before continuing. Do not treat import as an upsert.

## Interpret results accurately

- `persistence: "session-only"` means the change exists only in the open
  session's working copy; it is lost on reopen unless saved in Make.
  `session-readback-matched` means the session accepted the write and the content
  read back equal; `session-delete-accepted` means the session accepted a removal.
  Neither means the project was saved, the app built, or it was published.
- `outcome: "refused"` on a replacement error means the file changed after the
  backup and no write was sent; `outcome: "uncertain"` means the write may have run.
- `remote-content-matched` means the session's source bytes equal the manifest;
  it does not prove the files were saved.
- `changed: false` means replacement found identical content and wrote nothing.
- `preview` reports the current rendered app. Check the intended headings/content
  as well as `errorOverlay`; an empty overlay alone does not prove the right app ran.
- `diagnostics` reports the selected editor's current lint ranges. Only
  `available: true` confirms that lint state was readable; an empty array with
  `available: false` does not mean error-free. Language-server updates can lag a write.
  Preview `regions` reports panel and tab bounds for layout checks; a rendered app
  is not evidence that its TypeScript editor is free of errors.

The adapter uses an observed authenticated filesystem socket in Figma Desktop's
loaded Make page, and the Make editor for diagnostics. It is an experimental private protocol, not a public Figma API.
It requires neither an additional API key nor copying cookies/tokens. Let the CLI
manage it; do not reconstruct protocol calls or change debugging ports ad hoc.
