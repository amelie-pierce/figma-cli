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

Build JSON with a serializer; do not splice React source into shell command text.
Use a process API with an argument array and stdin. For example, when Python is
available, run a quoted heredoc in the shell so backticks and `$()` in source stay
literal. The Python snippet below shows the pattern; its `new_source` is a prepared
in-memory string, not a file to create locally.

```python
import json
import subprocess

cli = "figma-cli"  # Replace with the workspace's resolved launcher.
key = "EXACT_MAKE_FILE_KEY"

def run_make(*args, payload=None):
    completed = subprocess.run(
        [cli, "make", *args, "--file", key],
        input=payload, text=True, capture_output=True, timeout=135,
    )
    if completed.returncode:
        # Preserve partial acknowledgements/backup information. Never auto-retry.
        raise RuntimeError(completed.stderr or completed.stdout)
    return json.loads(completed.stdout)

original = run_make("read", "src/App.tsx")
# Prepare new_source from original["content"] and the requested change.
# Only add required imports after their modules have been created.
saved = run_make(
    "replace", "src/App.tsx", "--from", "-",
    "--expected-sha256", original["sha256"], payload=new_source,
)
verification = run_make(
    "verify", "--manifest", "-", "--timeout", "120000",
    payload=json.dumps({"files": [{"path": "src/App.tsx", "content": new_source}]}),
)
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
