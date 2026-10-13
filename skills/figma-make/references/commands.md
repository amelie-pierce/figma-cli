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
| Verify expected session content | `figma-cli make verify --file KEY --manifest - --timeout 120000` |
| Check vendor drift and saved state, including hidden files | `figma-cli make drift --file KEY --manifest VENDOR.json --json` |
| Inspect the running preview | `figma-cli make preview --file KEY` |
| Read source editor diagnostics | `figma-cli make diagnostics src/App.tsx --file KEY` |

Read commands return `{fileKey,path,content,sha256,source}`. `--out` is optional and writes
a local source copy; omit it in a direct-to-Make/no-local-app-code workflow.
`--from -` and `--manifest -` accept blocking stdin, including large source payloads.
No special stdin preloader or temporary source file is needed.

Every write command needs `--session-only`; without it the CLI refuses before
connecting (`code: "MAKE_SESSION_ONLY_REQUIRED"`). Writes change only the open
session's working copy and are lost when the file is reopened unless the user
saves them in Make, which creates a new version through the file's saving mode.

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
