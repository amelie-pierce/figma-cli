---
name: figma-cli
description: Build and edit designs directly in Figma Desktop from the terminal using the figma-cli command (controls Figma live over a local connection, no API key). Use whenever the user wants to create, render, or edit Figma frames/components/variants, add or import design tokens/variables (shadcn, Tailwind, DTCG, CSS), extract a design system to DESIGN.md, generate gradients/wallpapers, animate with Figma Motion, run accessibility audits, or connect an AI assistant to their Figma. Triggers on "build/make X in Figma", "add my design system", "create N buttons/cards", "use my variables", "export the design system", "check contrast".
---

# Using figma-cli

For Figma Make application source, use the dedicated
[figma-make skill](../figma-make/SKILL.md). The Design canvas workflow below does
not edit Make source files.

figma-cli controls **Figma Desktop** directly (no API key). It runs in any
terminal. Open Figma Desktop, then `figma-cli connect` once per session.

If the `figma-cli` command is not found, the tool isn't installed yet — see
**Installation** at the bottom. Never show raw terminal commands to the user;
run them silently and give friendly feedback.

## CLI-only operation

Use Node/CLI commands for discovery, inspection, creation, editing, and verification.
Do not invoke computer-use tools, OS mouse/keyboard automation, screenshot-coordinate
clicking, or separate browser-automation tools to operate Figma. CLI image exports
are valid visual evidence and can be inspected without controlling the screen.
If the CLI cannot access a file or perform a required action, report the blocker
and the missing prerequisite; do not silently fall back to computer use. The user
may need to open/sign in to Figma or grant a required initial connection permission.
Keep unsupported interaction tests explicitly unverified.

## Direct Node.js invocation

If the user requests Node execution or shell launchers are unavailable, invoke
this package's `src/index.js` with `process.execPath` and an argument array using
`shell: false`. Preserve the workspace's configured port/environment. Resolve the
package location at runtime; do not publish a user's absolute machine path.
For a Node installation, read `nodeExecutable` and `cliEntry` from the local
`~/.figma-cli/node-runtime.json` record (owner `amelie-pierce/figma-cli`) and verify
both paths exist. This lets a local Copilot agent find the CLI outside its folder
without shell or PATH lookup. Keep the record's machine-specific values local.
See the README's **Run directly from Node.js** example. Initial connection/setup
commands still invoke operating-system helpers. Make has a dedicated
`connect --make` path that invokes them directly without a shell. Older Design,
Safe, and Browser setup paths still contain shell-dependent operations.

## Connect (pick one mode)
First run `connection` for a read-only endpoint diagnostic. Port precedence is
`--port`, `FIGMA_PORT`, saved `~/.figma-cli/connection.json`, then 9222. Persist a
known Desktop port with `connection --save-port PORT`; installation also accepts
`--port PORT`. Installation alone does not enable debugging. Do not infer a macOS
permission denial from an unreachable endpoint or restart a healthy connection.
After an authorized patch/restart, `connect` checks CDP; the editor may still need
to finish loading before design operations work.

- `figma-cli connect` — **Yolo** (default): patches Figma Desktop once, fully automatic.
- `figma-cli connect --browser` — **Browser**: drives Figma in a Chromium browser via
  a local connection; **never modifies the Figma app**. Use when patching the desktop
  app is undesirable (compliance / locked-down machine / no "App Management" permission).
- `figma-cli connect --safe` — **Safe**: official plugin (Plugins → Development → FigCli).

## Golden rules
1. **Create frames with `render` / `render-batch`** — they have smart positioning.
   NEVER use `eval` to create visual nodes (no positioning, bypasses guards).
2. **"N buttons/cards" = N separate top-level nodes**, not one wrapper frame
   containing N children. Use `render-batch '[...]'` or `shadcn add <c> --count N`.
3. **Never delete the user's existing nodes.**
4. After creating, **verify**: `figma-cli verify "<id>" --measure` (returns a
   screenshot + real w/h so you catch size bugs by numbers, not by eye).

## Design tokens / variables
- Bind colors at creation with `var:name`, never raw hex when a system is loaded:
  `<Frame bg="var:primary"><Text color="var:on-primary">Go</Text></Frame>`
- Pin a named collection when the user names one: `render-batch ... --collection figma`.
- Import a system: `figma-cli import tailwind.config.js | globals.css | tokens.json`.
- Export the open file's system: `figma-cli extract` → DESIGN.md.

## JSX cheatsheet (render)
- Layout: `flex="row|col" gap={16} p={24} px py pt pr pb pl justify="center|between" items="center"`
- Size: `w={320} h={200} w="fill" w="hug" w="60%"` (percent resolves vs parent)
- Look: `bg="#fff" stroke="#000" strokeWidth={2} rounded={12} shadow="..." opacity={0.8}`
- Text: `<Text size={14} weight="semibold" color="#000" lineHeight={20} truncate maxLines={2} w="fill">`
- Icons (real SVG, never emojis): `<Icon name="lucide:home" size={20} color="var:primary" />`
- Dividers: a thin child (`<Frame w={1} bg="var:border" />`) auto-fills the cross axis.

## Text wrapping (most common bug)
For text to wrap, the parent AND every `<Text>` need `w="fill"`, and the parent
needs `flex="col"` or `flex="row"`.

## Recreating a component from an extracted DESIGN.md (hard rule)
Don't read the structure markdown by hand. Use:
- `figma-cli spec <Component>` → authoritative variant axes + sample size (compact).
  Build EXACTLY to those axes (e.g. Variant × Size = a Component Set, not one node).
- `figma-cli spec <Component> --check <nodeId>` → enforces it (exit 1 on mismatch:
  wrong structure, missing axes, wrong height). Treat non-zero as "not done".

## Handy commands
```
figma-cli connect                      # connect to Figma Desktop (yolo)
figma-cli render '<Frame>...</Frame>'  # one frame
figma-cli render-batch '[ "<Frame>", ... ]' --direction row
figma-cli shadcn add button --count 3  # N distinct shadcn primitives
figma-cli node to-component "<id>"     # promote to a component
figma-cli verify "<id>" --measure      # screenshot + dimensions
figma-cli a11y audit                   # contrast / touch / text checks
figma-cli tokens preset shadcn         # 244 primitives + semantic (light/dark)
figma-cli var visualize                # show colors on canvas
figma-cli motion preset <id> fade-up   # animate (Figma Motion, beta)
figma-cli blocks create dashboard-01   # pre-built dashboard layout
```

## Figma Make source editing

For Make app source, use the dedicated [figma-make skill](../figma-make/SKILL.md)
and the separate `make` commands. Respect the workspace's configured launcher,
which may select Figma's dedicated port and Node runtime.
Start with `make list`, then `make inspect`, `make files`, and `make read` with
an exact `--file` key or Make URL. Source edits use `make replace --from` with
the SHA-256 returned by the prior read. Preserve the returned backup path.

Do not route Make source through Design `eval`, `render`, or the Design daemon.
The Make adapter opens the Code tab and observes Make's own save acknowledgement.
For new modules, use `make create --from -` or `make import --manifest -` with
`{files:[{path,content}]}` streamed through stdin. Imports reject existing paths.
Use `make verify --manifest -` for exact remote-content checks and `make preview`
for read-only inspection of the running app. Keep React/TSX as readable source,
with library modules separate; do not paste compiled bundles into App.tsx.
These commands need no local application-code files and no computer-use tools.
Do not claim a passing build or publication from a successful source save.
After an uncertain write outcome, read first; do not retry or restore blindly.
Never reload the desktop CDP page to verify a save: Figma Desktop's tab lifecycle
can leave that view hidden or stalled. The adapter verifies the server response
without reloading.

## Installation
figma-cli is a Node CLI (Node ≥ 18) that talks to Figma Desktop locally. If the
`figma-cli` binary is missing, get the project from
https://github.com/amelie-pierce/figma-cli. For Node-only installation, launch the
extracted `install.mjs` with Node and use its runtime record as described above.
The npm/installed-launcher route is also supported when permitted. Full command
reference and JSX docs live in that repo's README.md and REFERENCE.md.
