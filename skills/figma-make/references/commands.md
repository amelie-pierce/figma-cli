# Command and transfer patterns

Use the workspace's resolved launcher instead of the literal `figma-cli` below
when one is specified. Always supply the exact Make file key or URL to `--file`.
These examples are templates; choose paths/content for the actual requested work.

| Purpose | Command |
| --- | --- |
| Discover open projects | `figma-cli make list` |
| Check readiness | `figma-cli make inspect --file KEY` |
| Inventory source | `figma-cli make files --file KEY` |
| Read source and hash | `figma-cli make read src/App.tsx --file KEY` |
| Read saved Markdown or installed kit source | `figma-cli make read AGENTS.md --remote --file KEY` |
| Create a new module | `figma-cli make create src/Component.tsx --file KEY --from -` |
| Import new modules | `figma-cli make import --file KEY --manifest - --timeout 120000` |
| Replace existing source | `figma-cli make replace src/App.tsx --file KEY --from - --expected-sha256 HASH` |
| Verify expected content | `figma-cli make verify --file KEY --manifest - --timeout 120000` |
| Inspect the running preview | `figma-cli make preview --file KEY` |
| Read source editor diagnostics | `figma-cli make diagnostics src/App.tsx --file KEY` |

Read commands return `{fileKey,path,content,sha256}`. `--out` is optional and writes
a local source copy; omit it in a direct-to-Make/no-local-app-code workflow.
`--from -` and `--manifest -` accept blocking stdin, including large source payloads.
No special stdin preloader or temporary source file is needed.

Use `read --remote` when Make displays Markdown as a preview instead of editable
text, or to inspect an attached kit under `node_modules/`. It reads saved UTF-8
source through the observed filesystem connection without changing the file.
Project paths must appear in the source inventory; installed
package paths under `node_modules/` may be hidden from that inventory. This reads
saved content, so use the ordinary read for unsaved editor changes.

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
  // Preserve partial acknowledgements and backup information, including on error.
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
const saved = runMake([
  'replace', 'src/App.tsx', '--from', '-',
  '--expected-sha256', original.sha256,
], newSource);
console.log(saved); // Retain the returned backup path.

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

- `server-acknowledged` means Make acknowledged saving; creation also reads back
  its content. It does not mean the app built or was published.
- `remote-content-matched` means the server's source bytes equal the manifest.
- `changed: false` means replacement found identical content; it is not a new save.
- `preview` reports the current rendered app. Check the intended headings/content
  as well as `errorOverlay`; an empty overlay alone does not prove the right app ran.
- `diagnostics` reports the selected editor's current lint ranges. Only
  `available: true` confirms that lint state was readable; an empty array with
  `available: false` does not mean error-free. Language-server updates can lag a save.
  Preview `regions` reports panel and tab bounds for layout checks; a rendered app
  is not evidence that its TypeScript editor is free of errors.

The adapter uses Figma Desktop's loaded Make editor and an observed authenticated
filesystem socket. It is an experimental private protocol, not a public Figma API.
It requires neither an additional API key nor copying cookies/tokens. Let the CLI
manage it; do not reconstruct protocol calls or change debugging ports ad hoc.
