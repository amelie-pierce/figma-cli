# figma-cli

## Amelie Pierce fork: Figma Make and agent skills

This fork of [silships/figma-cli](https://github.com/silships/figma-cli) adds direct
Figma Make source editing and bundles **figma-cli** (Design) and **figma-make**
(React source) skills. The original MIT license and author attribution are retained.

### Copy-and-paste installation prompt

Copy this prompt into Claude Code, Codex, or GitHub Copilot running on the same
computer as Figma Desktop:

```text
Install the amelie-pierce fork of figma-cli and set it up for direct Figma Make editing.

Use Node.js 22 LTS. Download and extract https://github.com/amelie-pierce/figma-cli/archive/refs/heads/main.zip with available download/file tools. Run the extracted install.mjs with Node and --agent all (or --agent copilot for Copilot only), using an argument array and shell: false. Do not use Bash, CMD, PowerShell, or npm shell shims. The installer locates npm-cli.js and installs dependencies with lifecycle scripts disabled.

Read the local ~/.figma-cli/node-runtime.json record to locate Node and src/index.js. Use those to run `skills status --agent copilot` (or --agent all). Ensure both figma-cli and figma-make skills are ready. Preserve customized skills if the installer reports a conflict.

Read the figma-make skill. Reuse an existing Figma Desktop connection, or set up a dedicated free debugging port with `connect --make --port PORT`. Explain any required app patch or restart before proceeding. This Make setup invokes OS helpers directly without a shell, but still needs the OS permissions to modify and launch Figma.

Run `connection` through the Node entry point first. Report the exact endpoint and port source. Installation alone does not enable Desktop debugging. Reuse the known Desktop port; persist it with `connection --save-port PORT` when needed. Do not guess a port or restart a healthy connection. Then verify with `make list` and ask me for the Make URL and desired changes.

If shell launchers are unavailable, invoke the installed JavaScript entry point with Node.js and an argument array (shell: false), preserving the configured port. Do not embed personal absolute paths in shared instructions.

For Make work, write readable React/TSX directly through the CLI using stdin. Keep modules separate, avoid local application source files and computer-use tools, and verify saved source and the preview after editing. Keep publishing separate from editing. If CLI access fails, report the blocker; do not fall back to computer-use, mouse/keyboard automation, or screenshot clicking.
```

### Install for Claude Code, Codex, and GitHub Copilot

With Node.js 22 LTS installed, run:

```sh
npm install -g https://github.com/amelie-pierce/figma-cli/archive/refs/tags/v2.2.5-make.2.tar.gz
figma-cli skills status
```

Installation registers every bundled skill, including its reference files, in:

| Agent | User skill directory |
| --- | --- |
| Claude Code | `~/.claude/skills` (or `$CLAUDE_CONFIG_DIR/skills`) |
| Codex | `~/.agents/skills` |
| GitHub Copilot CLI / VS Code | `~/.copilot/skills` |

These follow the documented discovery locations for
[Claude Code](https://code.claude.com/docs/en/skills),
[Codex](https://developers.openai.com/codex/skills/), and
[Copilot](https://code.visualstudio.com/docs/agent-customization/agent-skills).
Reload skills or start a new agent session after installation. In Codex, invoke
`$figma-make`; in Claude Code or Copilot, invoke `/figma-make` or ask to edit a Make
project directly. Discovery makes the skills available; agent permissions and
disabled-skill settings still apply. Remote/cloud agents cannot reach a local
Figma Desktop just by installing a skill.

The installer updates only unchanged copies it owns. It preserves custom skills,
local edits, and unrelated symlinks and reports conflicts. `skills status` exits
nonzero if anything is missing, outdated, or conflicted. Inspect a conflicting
directory and move your custom copy aside yourself before retrying; no force
overwrite is performed. npm can hide postinstall output, so check status.

```sh
figma-cli skills install                  # repair registration for all three
figma-cli skills install --agent codex    # or claude / copilot
```

When npm lifecycle scripts are disabled, run `skills install` explicitly.
Set `FIGMA_CLI_SKIP_SKILLS=1` during installation to opt out of user skill writes.
The CLI remains installed if skill registration encounters a permission conflict;
the status command identifies any incomplete registration. Uninstalling the npm
package leaves the skill copies in place; remove its two skill directories from
the table above if you no longer want them.

This release is distributed from GitHub, not the public npm registry. To update,
install a newer tag from **this fork** and run `skills status` again. The upstream
npm update notification is disabled so it cannot replace the Make extension.

### Install with Node.js, including GitHub Copilot

Download and extract [this fork's ZIP](https://github.com/amelie-pierce/figma-cli/archive/refs/heads/main.zip).
The archive includes `install.mjs`; the older `v2.2.5-make.2` tag does not.
Use a Node.js 22 runner to launch `install.mjs` from the extracted folder with
arguments `--agent copilot`. An IDE Node launch configuration works without an
integrated terminal. To register Claude Code and Codex too, use `--agent all`.

For a Node-capable agent or an existing Node script, set its working directory
to the extracted folder and run:

```js
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const result = spawnSync(process.execPath, [
  resolve('install.mjs'), '--agent', 'copilot',
], { shell: false, stdio: 'inherit', timeout: 330000 });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`Installer exited with ${result.status}`);
```

The installer locates npm's `npm-cli.js` from the Node installation and runs it
with Node directly. It uses the lockfile when present, disables dependency
lifecycle scripts and executable shims, then registers and verifies both skills.
It never invokes Bash, CMD, PowerShell, `npm.cmd`, or a shell launcher. Standard
Node/npm layouts on Windows, macOS, and Linux are supported. If npm is installed
separately, supply `--npm-cli` followed by its `npm-cli.js` path. Existing registry,
proxy, and TLS settings are respected. Node with npm and registry access are
required; no global installation or PATH modification is performed.

After installation, keep that folder in place and use its `src/index.js` as the
CLI entry point. The installer saves its location and Node executable in
`~/.figma-cli/node-runtime.json`; both skills teach agents to read this local
record when the CLI is not on PATH. These generated machine paths stay local. Copilot discovers `figma-cli` and `figma-make` under
`~/.copilot/skills`, as documented by
[GitHub](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills) and
[VS Code](https://code.visualstudio.com/docs/agent-customization/agent-skills).
In a **local** Copilot CLI or VS Code agent session, reload skills and use
`/figma-make` or ask to edit an open Make project. Confirm both skills in Copilot's
Skills customization view, and use `skills status --agent copilot` through the
Node entry point to check their installed content. Copilot must have an allowed
local Node execution tool; skill discovery alone does not grant execution access.
A cloud Copilot session cannot reach your local Figma Desktop.

The installer does not connect, patch, or restart Figma. Skill conflicts are
preserved and reported with a nonzero exit status. Installation tests verify
registration and CLI execution; they do not certify a live Copilot model session.

### Desktop connection diagnostics and saved port

Installing the CLI and opening Figma do **not** enable remote debugging. Run the
read-only `connection` command first. It prints the exact loopback endpoint, the
effective port and its source, and whether CDP exposes Figma/Make targets. It never
patches, restarts, scans other ports, or edits Figma. A discovered target does not
prove the editor is ready; use `make inspect --file KEY` after discovery.

Port precedence is **`--port` → `FIGMA_PORT` → saved setting → 9222**. All Make
commands accept the global `--port`, including `make list --port PORT`. Invalid
values fail explicitly instead of silently falling back to another service.

Persist a known Desktop port with `connection --save-port PORT`, or pass
`--port PORT` to `install.mjs` when installing. This saves only local settings in
`~/.figma-cli/connection.json`; it does not enable debugging or verify the endpoint.
Reinstallation without `--port` preserves that setting. Installer output reports
the effective port, any saved port supplied to it, and `verified: false`.

For Node agents, pass these argument arrays after the locally resolved CLI entry
point using `spawnSync(nodeExecutable, [cliEntry, ...args], { shell: false, ... })`:

```js
['connection']                              // Read-only diagnostic
['connection', '--save-port', '9333']       // Save a known port; example only
['make', 'list', '--port', '9333']           // Temporary override
['make', 'inspect', '--file', 'MAKE_KEY']    // Uses the saved port
```

If `FIGMA_PORT` is set, it overrides saved settings; the diagnostic reports this.
Reuse the port configured for that device, not a port copied from someone else's
machine. Never stop another service to free it.

| Diagnostic | Meaning and recovery |
| --- | --- |
| `endpoint-unavailable` / `CDP_DISCOVERY_FAILED` | Includes URL, port, and underlying reason such as `ECONNREFUSED`. A wrong port and Figma launched without debugging can look identical. Confirm the launch configuration first. |
| `no-figma-target` | CDP responds, but no Figma page is exposed. It may be another browser/service or a Desktop session without a loaded tab. Confirm the port and open the intended file. |
| `PATCH_PERMISSION_DENIED` during `connect` | The patch operation was denied. On macOS, check App Management for the app hosting the agent/Node process. Managed devices may require administrator help. |
| `PATCH_FAILED` | A different patch failure, such as an incompatible app version; the original error is retained. Do not assume permission denial. |

When initial patch/restart is authorized, use **`connect --make --port PORT`** for
Make. It reuses a responding Figma endpoint, or patches/restarts Desktop and checks
CDP with a bounded wait. It invokes OS helpers directly with argument arrays and
`shell: false`; it needs no Bash, CMD, PowerShell, curl, or Design daemon. It does
not kill a service to free a port. This verifies discovery, not source editor
readiness. The older Design/Safe/Browser setup paths still contain shell-dependent
operations and are not covered by this guarantee.

Direct invocation does not remove OS permissions. On macOS, modifying Figma may
require App Management approval; on Windows, the user needs write access to the
Figma installation and permission to launch processes. If company policy blocks
these, report the prerequisite and ask for approved IT setup. Plugin/Safe mode
does not provide Make access. No computer-use tools are required.

Desktop discovery supports `/Applications/Figma.app` and `~/Applications/Figma.app`
on macOS, and the per-user Figma installation under `%LOCALAPPDATA%` on Windows.
Windows version folders are compared numerically and the binary and archive are
selected from the same complete version. For a custom installation, set
`FIGMA_APP_PATH` to the `.app` bundle on macOS or the installation folder on Windows.
An invalid explicit override does not silently select a different installation.
See [platform support and verification limits](docs/PORTABILITY.md).

### Run directly from Node.js

The CLI is a JavaScript program. An IDE or agent with a Node.js runtime can run
it directly, without a Bash, CMD, PowerShell, or npm-generated launcher. Once the
package and dependencies are installed, set the runner's working directory to
the package root (the directory containing `package.json` and `src/`).

```js
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const cliEntry = resolve('src/index.js');
const result = spawnSync(process.execPath, [
  cliEntry, '--port', '9333', 'make', 'list',
], {
  shell: false,
  encoding: 'utf8',
  env: process.env,
  timeout: 15000,
});

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(`CLI exited with ${result.status}`);
```

Use your configured Figma port; `9333` is an example. If the package is a local
dependency instead, resolve its entry point with
`createRequire(import.meta.url).resolve('@amelie-pierce/figma-cli/src/index.js')`
using `createRequire` from `node:module`. No personal absolute path is needed.
Pass source or manifests through the process API's `input` option, and pass each
CLI argument as a separate array element. See the
[Node source-transfer example](skills/figma-make/references/commands.md#transfer-source-safely).

This is a launch option for environments where Node execution is allowed.
Initial setup commands such as `connect` can invoke operating-system helpers;
the direct Make editing workflow uses the existing Desktop connection.

### Connect and edit Make

Installation itself does not patch, restart, or connect to Figma. Open your Make
project in Figma Desktop. On first setup only, connect using a dedicated free
debugging port, then use the same port for subsequent commands:

```sh
figma-cli --port 9333 connect --make
figma-cli --port 9333 make list
figma-cli --port 9333 make inspect --file YOUR_MAKE_FILE_KEY
figma-cli --port 9333 make read src/App.tsx --file YOUR_MAKE_FILE_KEY
```

`connect` may patch and restart Figma Desktop; follow your machine's policy and
reopen the Make project afterward. Existing installations should reuse their
configured port and launcher. Never restart a healthy Make connection just to
verify source. Plugin/Safe mode is for Design and does not supply the Make adapter.

The Make skill handles readable React/TSX, new modules, dependencies, hash-guarded
replacement, backups, remote-content verification, and preview inspection.
Source can travel entirely through stdin, with no local application source copies.
See [the Make skill](skills/figma-make/SKILL.md) and [command reference](REFERENCE.md).
Make uses an experimental private filesystem protocol through your loaded editor;
Figma changes may require adapter updates. Saving source is separate from publishing.

### No computer-use tools required

The supported agent workflow uses Node.js and CLI commands throughout. Copilot,
Codex, and Claude do not need computer-use tools, operating-system mouse/keyboard
control, screenshot-coordinate clicking, or a separate browser-automation tool.

- **Install:** launch `install.mjs` with Node; it registers the bundled skills.
- **Design:** inspect and edit through Design commands and verify with CLI exports.
- **Make:** discover, read, edit, verify, and inspect previews through `make` commands.
- **Recovery:** inspect through the CLI and report a blocked capability; never
  silently switch to computer-use tools when a command fails.

The Make adapter selects the Code tab and source files programmatically over its
Desktop connection. Design `verify` exports an image through the design API;
reading that export does not require screen-control tools. Figma Desktop must be
running, signed in, with the intended file open and loaded. Initial connection
setup and any required system permission remain prerequisites. Unsupported
interaction checks stay explicitly unverified.

### Verify the extension

```sh
FIGMA_CLI_SKIP_SKILLS=1 npm ci
npm run test:make
```

The Make and skill-installer suite is offline. Do not run upstream live Design
fixture tests against a personal Figma session. The original Design documentation
continues below; its connection-mode claims apply to Design, not Make.

---

<p align="center">
  <a href="https://www.intodesignsystems.com/"><img src="https://img.shields.io/badge/Into_Design_Systems-intodesignsystems.com-ff6b35" alt="Into Design Systems"></a>
  <img src="https://img.shields.io/badge/Figma-Desktop-purple" alt="Figma Desktop">
  <img src="https://img.shields.io/badge/No_API_Key-Required-green" alt="No API Key">
  <img src="https://img.shields.io/badge/No_MCP-Required-green" alt="No MCP Required">
  <img src="https://img.shields.io/badge/No_Rate_Limits-✓-green" alt="No Rate Limits">
  <img src="https://img.shields.io/badge/Works_in-Claude_Code-D97757?logo=claude&logoColor=white" alt="Works in Claude Code">
  <a href="#using-cursor"><img src="https://img.shields.io/badge/Works_in-Cursor-000000?logo=cursor&logoColor=white" alt="Works in Cursor"></a>
  <a href="https://www.linkedin.com/in/silbormueller"><img src="https://img.shields.io/badge/Built_by-Sil_Bormüller-0A66C2?logo=linkedin&logoColor=white" alt="Built by Sil Bormüller"></a>
</p>

<p align="center">
  <b>Talk in plain English. Watch Figma build.</b><br>
  You describe what you want, an AI assistant builds it live in your Figma Desktop.<br>
  No API key. No copy-paste. No plugin to babysit. No code to write.
</p>

<p align="center">
  Built by <b>Sil Bormüller</b>: Founder of <a href="https://www.intodesignsystems.com/">Into Design Systems</a><br>
  Join my AI conference: <a href="https://www.intodesignsystems.com/">AI Design Systems Conference 2027</a> on March 10 and 11 2027 online
</p>

---

## What is this?

figma-cli lets an **AI assistant build directly in your Figma Desktop**, while you talk to it in normal language.

You don't run commands or write code. You open **Claude** in this project and say things like:

> "Create three pricing cards."
> "Use my brand's design system."
> "Make those buttons look like Stripe."
> "Check the contrast on this screen."

Claude does the rest. Figma updates in real time, in front of you.

It works with real, editable Figma , actual frames, components, variants and variables , not a flat image. And it runs **locally**: no API key, nothing sent to a cloud service. No rate limits either ([why](#figma-cli-vs-the-mcp-servers-the-question-i-get-asked-most)).

---

## Setup , let your AI do it for you

You don't install this by hand. You use an **AI coding assistant** , **Claude Code** (recommended, what most people use) or **Cursor** , point it at this project, and ask it to set everything up.

> **Using Cursor?** Jump to [Using Cursor](#using-cursor) for the one-line setup. The steps below are for Claude Code; everything the CLI does is identical in both.

### 1. Have these ready
- **Figma Desktop** , installed and open ([download](https://www.figma.com/downloads/)).
- **Claude Code** , Anthropic's AI assistant for your computer. [Install it here](https://docs.claude.com/en/docs/claude-code) (one command, takes a minute). *(Or use Cursor , see below.)*

### 2. Get this project onto your computer
Don't know git? No problem. Open Claude Code anywhere and paste:

> "Download the figma-cli project from https://github.com/amelie-pierce/figma-cli into a folder in my home directory, then go into it."

(Or, if you prefer: click the green **Code** button on the GitHub page → **Download ZIP** → unzip it.)

### 3. Let Claude install and connect it
Open Claude Code **inside the project folder** and say:

> "Set up figma-cli and connect it to my Figma."

Claude reads the project's instructions, installs what's needed, and connects to your open Figma Desktop. You watch , you don't type commands.

When it says it's connected, you're done. ✅

### 4. Start designing , just talk
Now describe what you want:

> "Add my brand colors, then create a primary button and a secondary button."

Claude builds it in Figma instantly.

---

## Install as a Claude Code plugin (optional)

Prefer Claude Code's plugin system? This repo is also a **plugin marketplace**, so
Claude Code learns the figma-cli workflow in *any* project (not just this one) after
a two-line install:

```
/plugin marketplace add amelie-pierce/figma-cli
/plugin install figma-cli@amelie-pierce
```

That installs a skill that teaches Claude Code how to drive figma-cli (connect
modes, the render/JSX rules, tokens, verify, a11y). The **CLI itself still needs
Node ≥ 18 and its dependencies** , clone this repo and run `npm install` once (or
ask Claude to), then open Figma Desktop and say *"connect to Figma"*. The plugin
supplies the know-how; the local CLI does the work.

---

## Using Cursor

Prefer **Cursor**? It works exactly the same , the CLI controls Figma Desktop, not your editor, so nothing about it is Claude-only. Most people use Claude Code, but if Cursor is your tool, here's the whole setup.

### 1. Have these ready
- **Figma Desktop** , installed and open ([download](https://www.figma.com/downloads/)).
- **Cursor** , [download here](https://cursor.com).

### 2. Tell Cursor to install it , one line
Open Cursor in any folder, open the chat (the Agent), and paste:

> **"Install github.com/amelie-pierce/figma-cli and connect it to my Figma."**

Cursor downloads the project, installs it, sets up its own rules so it knows how to drive it, and connects to your open Figma Desktop. You watch , you don't type commands.

> Under the hood Cursor runs one extra command for itself , `figma-cli init-agent` , which drops a small `.cursor/rules/figma-cli.mdc` into your project. That's the file that teaches Cursor's Agent the rules (use real variables, wrap text properly, build N items as N components, etc.). You never edit it.

When it says it's connected, you're done. ✅

### 3. Start designing , just talk
Same as Claude Code , describe what you want:

> "Add my brand colors, then create a primary button and a secondary button."

Cursor builds it in Figma instantly.

**Already set up in a project and just want the Cursor rules?** Run `figma-cli init-agent` yourself , it writes the Cursor rules **and** an `AGENTS.md` (which Claude Code and Cursor both read), without touching any existing `CLAUDE.md`.

---

## How it connects to Figma: Yolo, Browser, or Safe mode

figma-cli talks to Figma in one of three ways. Claude picks one during setup , here's what they mean, so you know what's happening:

### ⚡ Yolo Mode , the default, recommended
- **Fully automatic.** Claude sets it up, you do nothing.
- It applies a **small, reversible patch** to the Figma Desktop app so the CLI can talk to it directly. That's what makes it fast and completely hands-off , no plugin to keep open, no clicking.
- "Yolo" sounds scary, but it's **safe and undoable** , Claude can un-patch it anytime, and nothing ever leaves your machine.
- Just tell Claude *"connect to Figma"* and you're done.

### 🌐 Browser Mode , same speed, without touching the Figma app
- Runs Figma in a **normal Chromium browser** (Chrome / Edge / Brave / Chromium) and drives it over the same fast direct connection , **the Figma Desktop app is never patched or modified.**
- Claude opens a browser window with remote debugging on, in its **own dedicated profile** (your Figma login and everyday browser stay untouched); you open your file there and keep working.
- Best when you can't or don't want to modify the desktop app , company policy, a locked-down machine, or macOS won't grant the "App Management" permission the patch needs. Just as fast as Yolo, and still fully local (no API key, no cloud).
- Tell Claude *"connect to Figma in browser mode"*.

### 🛡️ Safe Mode , no changes to the Figma app
- **Doesn't touch the Figma app at all.** Instead it uses a tiny built-in Figma plugin.
- You run it once from Figma's **Plugins → Development → FigCli** and keep that plugin open while you work.
- A little more manual (you start the plugin), but **zero modifications** to Figma itself , good if you, or your company's IT policy, don't want the app patched.
- Tell Claude *"connect to Figma in safe mode"*.

**All three do exactly the same things.** Unsure? Use Yolo. Want nothing changed on your Figma app but still want the fast direct path? Use **Browser**. Prefer the official plugin route? Use Safe. You can switch anytime , just ask Claude.

### Custom debug port (advanced)
Yolo and Browser mode both talk to Figma over CDP on port **9222** by default. If something else on your machine already uses that port (another Chrome with remote debugging, a browser automation tool), point figma-cli at a different one:

```bash
figma-cli --port 9333 connect     # flag
FIGMA_PORT=9333 figma-cli connect  # or env var
```

Invalid values fall back to 9222, so `connect` keeps working out of the box.

---

## figma-cli vs the MCP servers (the question I get asked most)

People keep asking how figma-cli differs from **Figma's official MCP** and from **figma-console-mcp**. Short version: they talk to Figma through the **cloud REST API**, figma-cli talks to **Figma Desktop directly on your machine**. That one architectural choice changes everything downstream.

| | **figma-cli** | Figma official MCP / figma-console-mcp |
|---|---|---|
| **How it connects** | CDP → your local Figma Desktop | Figma REST API (cloud) |
| **Figma token** | not needed | required (`figd_…`) |
| **Figma rate limit** | **none** (no API calls to throttle) | yes (as low as 6 read calls/month per seat) |
| **Works offline** | yes | no |
| **Setup** | one `connect` command | token + plugin/bridge + (for some) port wrangling |

### Why "no rate limit" is a real, structural advantage
Figma's APIs are rate-limited, and any tool built on them (Figma's official MCP included) runs into the same ceiling. The official MCP caps the tools that *read* from Figma by seat: just **6 calls per month** on a View/Collab seat, and **200 to 600 per day** (10 to 20 per minute) even on a paid Dev/Full seat ([source](https://developers.figma.com/docs/figma-mcp-server/rate-limits-access)). AI agents read constantly, so they burn through those fast, then sit in 429 cooldowns. figma-cli sidesteps all of it because it never calls the API: it drives Figma Desktop locally over CDP. No token, no 429, works offline.

### The quieter advantage: it costs your AI far fewer tokens
figma-cli's commands are terse and there are **no large tool schemas loaded into the AI's context**. Driving an MCP server, by contrast, loads its instructions + dozens of tool schemas and returns verbose JSON. Measured like-for-like in one session (tokens ≈ bytes ÷ 4, approximate):

| Task | figma-cli | API-based MCP |
|---|---:|---:|
| Cold start → first component | **~140 tok** | ~1,600 tok (**~11×**) |
| Generate one token-bound component | **~68 tok** | ~256–556 tok (**~4–8×**) |

On a fixed AI plan (e.g. Claude Pro), fewer tokens per task means you get more done before hitting *your AI's* usage limits too — and a leaner context means the AI keeps its facts straight instead of "forgetting" node IDs as the window fills.

**Bottom line:** local, no token, no rate limit, no cloud round-trip, and the lowest token cost — built for fast, reliable building and verifying from Claude Code or Cursor.

---

## What you can ask for

Just say it in plain language. A few examples:

**Build things**
- "Create 5 pricing cards in a row."
- "Make a login form."
- "Build a dashboard layout."
- "Add a dialog / a calendar / a sidebar." *(40+ shadcn/ui components available)*

**Use a design system**
- "Add shadcn colors" or "add Tailwind colors."
- "Make these in Stripe's style" / "use the Linear design system."
- "Use my brand's variables on these cards."

**Bring your own brand**
- "Import this design system" *(point it at a `DESIGN.md` file , see below)*
- "Switch this design from Stripe to Apple." *(swap a whole layout between brands)*
- "Export this file's design system as markdown." *(any open file → `DESIGN.md` , see below)*

**Animate (Figma Motion)**
- "Fade this card in / make it pop / slide it in."
- "Stagger these rows in one after another."
- "Add a keyframe animation , opacity 0 to 1 over half a second."

**Polish & hand off**
- "Check the color contrast / touch targets / text sizes."
- "Export this as PNG / SVG."
- "Turn this into a reusable component with Small / Medium / Large variants."

You never memorize commands. Claude knows them , you just describe the outcome.

---

## Bring your own design system

Have a brand or a design system? Put it in a single `DESIGN.md` file (colors, type, spacing) and tell Claude:

> "Import ~/Downloads/my-DESIGN.md into Figma."

It creates real Figma variables (`primary`, `canvas`, `ink`, `accent`, …) you can use everywhere , and you can switch a design between systems on demand ("now make it look like Vercel"). Ready-made `DESIGN.md` files for popular brands work too.

DESIGN.md is no longer the only way in. You can point `figma-cli import` directly at the source files your project already has:

- **Tailwind config** (`tailwind.config.js`) , colors, radii, spacing and font families land as Figma variables.
- **CSS custom properties** (`globals.css`, `styles.css`) , supports shadcn HSL triples, Tailwind v4 `@theme` blocks and oklch.
- **Design-tokens JSON** (`tokens.json`) , W3C design-tokens format and Style Dictionary files, including alias resolution.
- **Storybook** (`http://localhost:6006` or `./storybook-static/`) , imports your component inventory (names, variants) as context for the AI. Combine with a Tailwind or CSS import to get design tokens too.

Ask Claude: "Import my tailwind config" or "load our storybook at localhost:6006" and it handles the rest.

---

## Export any Figma file as DESIGN.md

The reverse also works. Open any Figma file , yours, a client's, a Community file like GitHub's Primer , and say:

> "Export the design system as markdown."

figma-cli scans **every page** (no truncation, even on 100k+ node files) and writes a `DESIGN.md` with the full token map: colors ranked by usage, the type scale, spacing, radii, shadows, plus a variant matrix for every component set (e.g. Button: variant × size × state, with all values). If the file defines real **variable collections**, it captures those too , every variable with its real name, all its modes (light/dark, high-contrast, whatever the system uses) and its alias chains , not just a palette sampled from fills. The file round-trips , `figma-cli import` recreates those collections faithfully (modes and aliases included) in any other file.

Components aren't just documented, they're addressable: `figma-cli spec "Button"` reads the markdown in code (zero model tokens) and returns just that one component's spec plus its reuse handle, so an agent pulls in exactly what it needs on demand instead of loading the whole file.

What it's for:

- **Feed your design system to AI tools** , Claude, Cursor, Copilot read DESIGN.md and build UI that actually matches your Figma file
- **Reuse, don't rebuild** , every component in the exported DESIGN.md carries a *reuse handle*. Ask for a component that already exists and the AI drops a real instance of it (`figma-cli instantiate "Button"`) instead of cloning a one-off copy, so your file stays consistent with the source system
- **Document a design system** , one command instead of hand-written token tables
- **Transfer a whole variable system between files** , extract from file A, import into file B and its collections come back with every mode and alias intact
- **Learn from Community files** , extract Primer, Material or any public system and see exactly how it's built

Huge files stay usable: when the structure trees alone would blow an AI context window, they're split into per-page files automatically and the main DESIGN.md stays small enough to load whole (Primer Web: 67 pages, 124k nodes → a 35k-token main file).

---

## Validate a design system without AI in the loop

A DESIGN.md is prose. An AI has to interpret it, so the only way to answer "is this still correct?" is a human looking at it. That is fine for building and useless for verifying.

So there is a second, deterministic half. No model takes part in it at all.

```bash
figma-cli snapshot     # → design.json, a canonical contract of the file (commit it)
figma-cli rules gen    # → rules/*.yaml, one contract per component
figma-cli check        # verify the open file against both, exit 1 on any violation
```

`design.json` is canonical: node ids, publish keys and timestamps are stripped, unordered sets sorted, floats rounded. The same system re-extracted, or exported and re-imported, compares byte-identical, so a difference always means a real change. The YAML contracts are generated **by code reading the Figma Plugin API**, not written by a model, and you review them once as a git diff.

What `check` enforces:

- **Drift** , anything that changed since the contract, reported with the exact path (`pages/Page 1/frames/Button/kids/size=sm/h: 32 → 56`)
- **Variant matrix** , every combination present, no unexpected axis values
- **Token binding** , every fill and stroke bound to a variable, so hardcoded hex gets caught. Measured across **all** variants, not a sample
- **Geometry** , heights within a stated tolerance, so a size regression is caught by number instead of by eye
- **State machine** , prototype transitions still wired ("on hover go to state=hover")
- **Roundtrip** (`--roundtrip`) , proof that the token layer survives export and import, which is the failure that used to silently re-import everything white

It exits non-zero and speaks `--json`, so it runs in CI. Red means *changed*, not *wrong*: if the change was intended, re-run `snapshot` and review the diff, exactly like a snapshot test.

Verified against GitHub's Primer (1015 nodes, 1381 variables, a 144-variant Button): repeated runs compare equal, all 576 fills and 144 strokes across every variant check out, and a one-character typo in a single variant name is caught in under a second.

What stays human is whether the contract describes the right design. You decide that once. After that it is arithmetic.

---

## Works offline / with local AI

Prefer to keep everything on your machine? figma-cli also works with **local LLMs** (via LM Studio or Ollama) , fully offline, no cloud, no key. Ask Claude to "set up the local LLM agent" and it'll walk you through it.

---

## Everything it can do

**40+ ready components · 40+ capabilities · 10 areas.** You trigger any of these just by asking.

**🧩 Components (40+ components + 3 tools)**
- 40+ shadcn/ui components (buttons, cards, inputs, dialogs, tabs, calendar, sidebar, …) with real Lucide icons
- Turn anything into a reusable **component** with **variants** (Size, State, …)
- Build **slots** for flexible, composable components
- Combine existing frames into a variant set

**🎨 Design systems & tokens (4)**
- One-command presets: **shadcn** (Light/Dark) and **Tailwind** color scales
- **Import your own brand** from a `DESIGN.md` , colors, typography, radius become real Figma variables
- **Switch a design between brands** (Stripe → Apple → your brand) , token names stay consistent
- Visualize a whole palette on the canvas

**🖼️ Visuals & effects (5)**
- Drop shadows, inner shadows, layer & background blur, glassmorphism
- Linear, radial, angular & diamond **gradients**
- **Extract a gradient from any image** , get a Figma-ready fill or a mesh wallpaper
- Generate **mesh-gradient wallpapers** from a color palette
- Image fills from any URL, corner smoothing (iOS squircles), rotation, blend modes

**📐 Layout & structure (4)**
- Real auto-layout (flex rows/columns, fill/hug, gaps, alignment)
- Pre-built **blocks** (full dashboards, page layouts) in one step
- Precise absolute positioning (pin to corners, center, stretch)
- Sections and layout grids to organize the canvas

**🎬 Motion & animation (5)** *(Figma Motion, Config 2026 Beta)*
- **Keyframe any property** , opacity, position, scale, rotation, corner radius, fills/strokes , with multi-step timing and per-keyframe easing
- **Presets** for instant polish: fade-in, fade-up, slide, pop, spin
- **Stagger / sequence** the same animation across many layers with one command
- Apply Figma's **first-party animation styles** and set **timeline** duration
- Author complex, multi-layer animations from a single JSON spec; inspect any layer's motion by numbers
- *Beta caveat:* Figma's Motion Beta may pair the animated frame (a second, identically-stacked copy in the Layers panel). It's a Figma-side behavior, cosmetically invisible on canvas, and must not be deleted (the pair is linked). Apply motion once and don't re-run on the same frame.

**✅ Deterministic validation (5)** *(no model involved, CI-ready)*
- **Snapshot** the whole system to a canonical `design.json` and catch any later drift, with the exact path that changed
- **YAML contracts per component** , generated from the file itself, enforcing the variant matrix, axis values and geometry tolerances
- **Token-binding checks** across every variant, so a hardcoded hex can't sneak back in
- **State-machine checks** , prototype transitions ("on hover go to state=hover") verified, not assumed
- **Roundtrip proof** that the token layer survives export and import, the failure that otherwise re-imports everything white

**♿ Accessibility (4)**
- Contrast checking (WCAG)
- Touch-target sizing, text-size checks
- Color-blindness simulation
- One-shot full a11y audit

**📦 Handoff & export (4)**
- Export **PNG, SVG, JSX**, Storybook stories, CSS variables, Tailwind config, and **DTCG / W3C design-tokens JSON** , so tokens round-trip both ways (import *and* export)
- Link components to **Storybook / GitHub / docs**
- Inline **annotations** for usage rules and token references
- Recreate a live webpage in Figma from a URL

**🤖 Built for AI (6)**
- Works with **Claude Code** or **Cursor** , one `figma-cli init-agent` sets up the rules for both
- Works with **Claude**, or local LLMs via **LM Studio / Ollama** (fully offline)
- Ships the entire **Figma Plugin API spec offline** so the AI can self-discover
- Self-corrects when a command needs a different approach
- Screenshot-based verification (`verify --measure`) so the AI checks its own work by numbers
- Enforces a **DESIGN.md spec** when recreating components (`spec --check`) , no eyeballing
- Optional **voice control** (macOS): "create three pricing cards" out loud

**🔒 No strings (2)**
- No API key, no cloud roundtrip, no plugin store waits
- Talks to Figma Desktop directly , real, editable Figma every time

---

## For developers

Everything above is powered by a CLI that the AI calls for you. If you want to use it directly, script it, or see every command:

- **[REFERENCE.md](REFERENCE.md)** , full command reference (tokens, render/JSX, components, gradients, a11y, export, the offline Figma API spec, and more).
- Three connection modes: **Yolo** (direct, patches the desktop app, recommended), **Browser** (same direct speed via a Chromium browser, never modifies the Figma app), and **Safe** (plugin-based, no patching). Claude picks the right one during setup.

**Auto-layout, by example.** `npm run examples` renders a labelled gallery of the
auto-layout patterns that are easy to get wrong , wrapping card, space-between
navbar, stretching divider, toggle knobs, bottom-pinned sidebar, wrap grid,
min/max constraints, fill chain, z-stack , onto a page called "Auto-Layout
Patterns". It then **measures** what Figma actually produced and fails if any
number drifts, so it is documentation and a regression test at once.

```bash
npm test          # unit tests, no Figma needed
npm run examples  # render + verify the pattern gallery (needs a connected Figma)
npm run test:live # the above, plus render vs render-batch layout parity
```

You don't need any of this to use the tool , it's here for tinkerers.

---

## Why this exists

Figma plugins are slow to build and tied to one UI. AI assistants are great at *describing intent* but need a clean way to act on Figma. figma-cli is the bridge: it talks to Figma Desktop directly, so you can design by conversation , locally, with no API key and no cloud roundtrip.

**You design. The AI builds. Figma updates.**

---

## Security

What each connection mode touches (Yolo patches one string in Figma's `app.asar`, Browser and Safe Mode leave the app alone), what the local daemon does, and where credentials live: [SECURITY.md](SECURITY.md). That is also the page to hand to whoever approves tools at your company.

Found a vulnerability? Report it privately via [GitHub private vulnerability reporting](https://github.com/silships/figma-cli/security/advisories/new) or sil@intodesignsystems.com, not in a public issue.

---

## Who built this

**Sil Bormüller**, founder of [Into Design Systems](https://www.intodesignsystems.com/), the conference and training platform for design system practitioners.

- LinkedIn: [linkedin.com/in/silbormueller](https://www.linkedin.com/in/silbormueller)
- Personal site: [silbormueller.com](https://www.silbormueller.com/)
- Into Design Systems: [intodesignsystems.com](https://www.intodesignsystems.com/)
- Newsletter with tutorials: [intodesignsystems.substack.com](https://intodesignsystems.substack.com/)
- GitHub: [@silships](https://github.com/silships)

Join my AI conference: [AI Design Systems Conference 2027](https://www.intodesignsystems.com/) on March 10 and 11 2027 online.

---

## License

MIT. Built by [Sil Bormüller](https://www.linkedin.com/in/silbormueller).
