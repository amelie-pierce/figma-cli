# AtomicAUI release: command recipes

Placeholders: `KEY` the kit's Make key (or its link), `OWNER/REPO` the workspace
repo from the baseline `VENDOR.json`, `LIB` its `source.path`, `GUIDES` the guide
folder named in its `guidance.source`, `BASE` / `NEW` the base and new workspace
commits, `WORK` your private working folder, `CLI_SRC` the CLI's `src` folder.
Check exact options with `figma-cli make <command> --help`; they win over this page.

Run the long Make commands (`status`, `drift`, `sync`, `save-version`, `release`,
`verify-release`, `export-delta`) as tracked background jobs, one at a time, with
`--timeout 120000`.

## Find CLI_SRC

The folder that holds the `src/index.js` the CLI runs. A Node installation
records it as `cliEntry` in `~/.figma-cli/node-runtime.json`; for a global npm
installation it is `$(npm root -g)/@amelie-pierce/figma-cli/src`. Check that
`CLI_SRC/make-atomicaui-kit.js` exists; if not, the installed CLI is too old.

## Hosted release

The CLI's own client: HTTPS only, the site address built in, `text/html` refused,
every hash in the chain checked. Set `V` to pin a version; `OUT` saves its
`VENDOR.json` (a new file).

```sh
CLI_SRC="…" V="" OUT="WORK/base/VENDOR.json" node --input-type=module -e '
import { pathToFileURL } from "node:url"; import { join } from "node:path"; import { writeFileSync } from "node:fs";
const m = await import(pathToFileURL(join(process.env.CLI_SRC, "make-atomicaui.js")).href);
const latest = await m.latestRelease();
const r = await m.downloadRelease({ version: process.env.V || latest.version });
if (process.env.OUT) writeFileSync(process.env.OUT, r.files.get("VENDOR.json"), { flag: "wx" });
console.log(JSON.stringify({ latest: latest.version, latestManifestSha256: latest.manifestSha256,
  version: r.manifest.version, manifestSha256: r.manifestSha256, files: r.manifest.files.length,
  vendorSha256: r.manifest.vendorSha256, dependencies: r.manifest.dependencies }));'
```

A download of an older version can take minutes; run it in the background.

## Workspace trees

```sh
gh repo clone OWNER/REPO WORK/ws -- --filter=blob:none --no-checkout
git -C WORK/ws fetch --quiet origin main
git -C WORK/ws rev-parse origin/main          # must equal NEW from gh api …/commits/main
git -C WORK/ws merge-base --is-ancestor BASE NEW && echo ancestor
for c in BASE NEW; do mkdir -p WORK/at-$c && git -C WORK/ws archive $c LIB GUIDES | tar -x -C WORK/at-$c; done
git -C WORK/ws log -1 --format=%cI NEW        # the commit date for VENDOR.json
git -C WORK/ws show NEW:<folder above LIB>/package.json   # its "name" is the package name
```

If `origin/main` differs from what `gh api` says, fetch again; never trust an
older clone.

## Library candidate

```sh
node CLI_SRC/make-atomicaui-kit.js vendor --baseline WORK/base/VENDOR.json \
  --base-library WORK/at-BASE/LIB --library WORK/at-NEW/LIB \
  --commit NEW --commit-date <date> \
  --out WORK/VENDOR-library.json --candidate-dir WORK/cand
```

It refuses with `KIT_BASE_DIFFERS` (BASE does not reproduce the baseline),
`KIT_TOKEN_GATE` (Core token files changed: stop), `KIT_FORMAT`, or an existing
output. On success it prints `added`, `changed`, `removed`, `fileCount`,
`inventoryDigest` and `sha256`, and writes `WORK/cand/src/vendor/atomic-aui/…`:
the whole new library at Make paths with the candidate `VENDOR.json`. Errors are
`{error, code}` on stderr with exit 1.

## Guides

Select (Phase 1), from the backed-up kit guides at NEW:

```sh
node CLI_SRC/make-atomicaui-kit.js check --source WORK/at-NEW/GUIDES --commit NEW \
  --package <name> --kit WORK/kit-guides --vendor WORK/base/VENDOR.json
```

`regenerate` lists the guides to transform: `otherCommit` guides whose `body`
`differs` at NEW (replayed under their own header commit, so a guide pinned to an
older commit is caught even when BASE..NEW leaves its doc alone) and `notInKit`
workspace guides. `body: "noSource"` is a removed guide: stop and report; this
skill does not remove guides.

Prove (Phase 2), per header commit `C` of the existing `regenerate` guides:

```sh
node CLI_SRC/make-atomicaui-kit.js check --source WORK/at-C/GUIDES --commit C \
  --package <name> --kit WORK/kit-guides --vendor WORK/base/VENDOR.json
```

`matched` and `recorded.matched` must hold every existing `regenerate` guide made
from `C` (extract `C` with `git archive` as above); `differs` with `recorded.matched` is a
hand-written note (stop and ask); `recorded.differs` means the kit copy was edited.

Transform (Phase 3):

```sh
node CLI_SRC/make-atomicaui-kit.js transform --source WORK/at-NEW/GUIDES --commit NEW \
  --package <name> --out WORK/guides-new --name <regenerate guide> [--name <guide> …]
```

## Sync (preferred path)

1. The workspace's own package for NEW: in a checkout of the workspace at NEW,
   `atomic-cli package-make-kit --ref NEW --out WORK/package` (add
   `--allow-missing-manifest` when the workspace has never committed
   `tokens/generated.manifest.json`). This tool belongs to the workspace; check its
   `--help`. Without it, use the fallback.
2. The request `WORK/request.json`, one entry per added, changed or removed
   library file (full Make paths; `null` for no baseline or no workspace file):

```json
{
  "schema": "figma-cli/make-sync-request@1",
  "fileKey": "KEY",
  "who": "<the person's name>",
  "requestId": "<any unique id>",
  "requestedAt": "2026-01-31T12:00:00.000Z",
  "direction": "workspace-to-make",
  "workspaceCommit": "NEW",
  "files": [
    { "path": "src/vendor/atomic-aui/<p>", "baselineSha256": "<sha in base VENDOR.json, or null>",
      "workspaceSha256": "<sha of WORK/cand/src/vendor/atomic-aui/<p>, or null>", "dependencies": [] }
  ],
  "choices": {}
}
```

   `requestedAt` must be an exact `toISOString()` value; `fileKey` the bare key.
3. Dry run, then apply on the person's yes:

```sh
figma-cli make sync --file KEY --package WORK/package --manifest WORK/base/VENDOR.json \
  --request WORK/request.json --candidate-dir WORK/cand --plan-out WORK/plan.json --timeout 120000
figma-cli make sync --file KEY --package WORK/package --manifest WORK/base/VENDOR.json \
  --request WORK/request.json --candidate-dir WORK/cand --apply WORK/plan.json \
  --receipt-out WORK/sync-receipt.json --backup-dir WORK/backup \
  --title "AtomicAUI sync from workspace <NEW short>" --timeout 120000
```

   Check the plan file: `vendorAfter.sha256` equals the `sha256` the helper printed.
   Never pass `--solo` or `--repo` to get past a mode refusal; a kit is solo, so a
   refusal there is a stop.

## Guides write (after a sync)

After a sync the next baseline is `WORK/sync-receipt.VENDOR.json` (the receipt's
`afterManifestPath`); check its SHA-256 equals the receipt's `afterManifestSha256`
and the helper's library `sha256`.

```sh
node CLI_SRC/make-atomicaui-kit.js vendor --baseline WORK/sync-receipt.VENDOR.json \
  --guides WORK/guides-new --out WORK/VENDOR-final.json
figma-cli make write guidelines/components/<g>.md --file KEY --from WORK/guides-new/<g>.md \
  --backup-dir WORK/backup [--expected-sha256 <recorded sha, for an existing guide>] --timeout 120000
figma-cli make write src/vendor/atomic-aui/VENDOR.json --file KEY --from WORK/VENDOR-final.json \
  --expected-sha256 <the receipt's afterManifestSha256> --backup-dir WORK/backup --vendor-tree-fallback --timeout 120000
figma-cli make status --file KEY --json        # pending paths = exactly the written set
figma-cli make save-version --file KEY --title "AtomicAUI guides from workspace <NEW short>" \
  --expected-path guidelines/components/<g>.md … --expected-path src/vendor/atomic-aui/VENDOR.json \
  --receipt-out WORK/save-guides.json --timeout 120000
```

## Fallback: file-by-file writes

Also the path for a guides-only release: with no library change the sync scope is
empty, so there is no sync receipt or `WORK/sync-receipt.VENDOR.json`.
Build one `VENDOR.json` with the library and the guides together (with an unchanged
library it moves only `source.commit`, `source.commitDate` and `guidance.files`):
`vendor --baseline WORK/base/VENDOR.json --base-library … --library … --commit NEW
--commit-date <date> --guides WORK/guides-new --out WORK/VENDOR-final.json`.
Then for each added file `make write src/vendor/atomic-aui/<p> --file KEY --from
WORK/cand/src/vendor/atomic-aui/<p> --backup-dir WORK/backup --vendor-tree-fallback`,
for each changed file the same plus `--expected-sha256 <baseline sha>`, for a removed
file (only on the person's yes) `make delete src/vendor/atomic-aui/<p> --expected-sha256
<baseline sha> --backup-dir WORK/backup`, then the guides, then `VENDOR.json` last
with `--expected-sha256 <baseline VENDOR.json sha>`. One `make save-version` names
every path. A write the CLI cannot place (a refusal, not a timeout) is a stop; do not
hand-roll another way in.

## Reload only the kit tab

```sh
CLI_SRC="…" KEY="…" node --input-type=module -e '
import { pathToFileURL } from "node:url"; import { join } from "node:path";
const { MakeClient } = await import(pathToFileURL(join(process.env.CLI_SRC, "make-client.js")).href);
const client = new MakeClient({ timeoutMs: 120000 });
try { await client.connect(process.env.KEY); console.log(JSON.stringify(await client.reloadPage())); } finally { client.close(); }'
```

Then run the same `make drift` again.

## Kit → workspace check

```sh
figma-cli make export-delta --file KEY --manifest WORK/VENDOR-final.json --who "<name>" \
  --candidate-dir WORK/cand --out WORK/delta.json --timeout 120000
```

The expected answer is the error **"No exportable saved changes in scope."** (clean).
Any delta lists kit edits that must go back to the workspace through its own review.
