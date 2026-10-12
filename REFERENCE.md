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
or write. If several Files tabs exist and none is active, select the intended one
manually; the CLI does not guess. If no Files tab exists, open one in the workspace.
`make ui --file KEY` reports bounded control metadata without selecting tabs or
reading source/input values. Use it for an unsupported layout. The old error
`Expected exactly one Make Code tab` may indicate an outdated CLI adapter, not a
missing project or a Desktop debugging/patch permission problem.

```sh
figma-cli make list
figma-cli make inspect --file <make-file-key>
figma-cli make ui --file <make-file-key>
figma-cli make files --file <make-file-key>
figma-cli make read src/App.tsx --file <make-file-key>
figma-cli make read AGENTS.md --remote --file <make-file-key>
figma-cli make diagnostics src/App.tsx --file <make-file-key>
figma-cli make replace src/App.tsx --file <make-file-key> --from - --expected-sha256 <hash-from-read>
figma-cli make create src/Component.tsx --file <make-file-key> --from -
figma-cli make import --file <make-file-key> --manifest - --timeout 120000
figma-cli make verify --file <make-file-key> --manifest - --timeout 120000
figma-cli make preview --file <make-file-key>
```

`read` returns the complete editor document and its SHA-256 as JSON. With
`--out`, source goes to a new local file (an existing file is not overwritten),
and stdout contains metadata. `files` expands and scrolls the virtualized file
tree so nested paths and repeated basenames are resolved unambiguously.
Each operation temporarily keeps the Make renderer active through CDP, allowing
its file tree to update while Figma is in the background, then clears that
override. It does not move operating-system focus. File selection verifies the
entire parent-folder chain before reading or writing. Selection collapses unrelated
folders so large vendor trees do not obscure an app file. Paths whose ancestors
and file still cannot fit together in the viewport are refused.

`replace` requires the previous content hash, saves a private local backup,
then applies one editor transaction. It observes Make's own file-write
request and matching successful server response, and rechecks the editor
content. It does not call a private write endpoint. Successful results report
`verification: "server-acknowledged"` and `persistence: "acknowledged"`.
This confirms the source file was saved; it does not certify a passing app
build, deployment, or publication. An unchanged file reports `changed: false`
and does not claim a new save.

Backups default to `~/.figma-cli/make-backups`; override with `--backup-dir`.
Their source files and metadata use private filesystem permissions. Keep the
returned backup path until the intended change is reviewed.

Writes reject stale editor content, a running Make generation, a visible
connection warning, unsupported editor structure, or read-only files. They
are never retried automatically. A timeout after a write may mean it saved:
read the file again before deciding what to do. To restore, read the current
hash and replace from the original backup with that hash. Do not blindly
replay a failed write or roll back over another person's changes.

Replacement files must be valid UTF-8 text, at most 2 MiB. Byte-order marks and
line endings are preserved when loading local source.

`--from -` and `--manifest -` read blocking stdin, so application source can stay
in memory and be saved directly into Make without creating local app files.
Import manifests use `{ "files": [{ "path": "src/Component.tsx", "content": "..." }] }`.
`create` and `import` reject existing paths, case-ambiguous duplicates, traversal,
and file/folder conflicts. Limits: 300 files, 2 MiB each, 20 MiB total source.

Creation uses Make's observed filesystem protocol on its existing authenticated
WebSocket. The adapter briefly observes a source-file read to identify that exact
connection, then restores the send hook. It reuses the connection in the same Make
page; it never extracts credentials or opens a separate authenticated connection.
The cached socket reference expires with the page/socket. Each write is acknowledged
and read back. This is an experimental private protocol, not a public Figma API.

Imports are sequential, not atomic. Errors report acknowledged files and requested
paths; other writes may have an uncertain outcome. Inspect and verify before
resuming, and submit only missing files. `verify` compares remote source bytes to
the manifest without changing files. `preview` inspects the current rendered app
and Vite overlay through the desktop connection; it does not reload or publish.

`remove <path> --expected-sha256 <hash>` is for explicitly authorized source cleanup.
It reads the exact remote file, checks its hash, writes a private recovery backup,
and requests removal of that file only. It does not recursively remove folders.
Keep its backup until cleanup is reviewed. Like replacement, this check is not a
server-side compare-and-swap; do not run concurrent writers on the same project.

Limitations: no rename, binary edits, or multi-file atomic changes. The content check is local to the active editor,
not a server-side compare-and-swap against other collaborators. The adapter
depends on the current CodeMirror editor and Make's observed save-response
format, so a Figma update may require adapting it. It does not reload the
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
