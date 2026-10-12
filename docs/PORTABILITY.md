# Platform support and verification limits

Use Node 22 and the main-ZIP installer for the current extension. Read the local
`~/.figma-cli/node-runtime.json` record to discover the installed entry point;
do not distribute a launcher containing another person's absolute path.

| Capability | macOS | Windows |
| --- | --- | --- |
| Node installation and agent skill registration | Supported | Supported |
| Persistent port and read-only connection diagnostics | Supported | Supported |
| Make CLI reads, guarded writes, backups, verification | Same adapter and offline suite | Same adapter and offline suite |
| Make initial connection | `connect --make` uses direct OS utilities | `connect --make` uses direct OS utilities |
| App modification permissions | App Management may be required | Installation write permission is required; App Management is not a Windows setting |
| Custom install location | `FIGMA_APP_PATH` points to the `.app` | `FIGMA_APP_PATH` points to the installation folder |

`connect --make` never starts the Design daemon, invokes a shell, or uses computer
control tools. It can reuse an existing Figma CDP endpoint without patch/restart.
Direct OS execution still depends on company policy and OS permissions. There is
no permission-free automatic Desktop setup if the required app modification is
blocked. The existing Design, Safe, and Browser setup commands retain legacy
shell dependencies; this Make-specific guarantee does not certify all commands.

The full offline Make suite runs on macOS, Windows, and Linux in CI. Fixtures
exercise the adapter, Unicode source preservation, stale-write rejection, save
acknowledgements, and backup content. Separate tests simulate installation layouts,
process failures, signing failures, and denied permissions. The installation
rehearsal uses a path containing spaces/Unicode, an empty PATH, and an unavailable
script shell. It checks Copilot skills and command entry points.

These tests do not install or patch Figma on CI, verify a live Windows editing
session, or exercise a real Copilot conversation. A local Mac discovery check is
not proof of Windows editor compatibility. Successful source saves do not prove
build success or publication.

Windows backup access follows Windows ACLs; POSIX `0600`/`0700` checks apply only
on Unix. Source content, hashes, and backup presence are tested on every OS.

Make's private editor interface can change independently of the OS. A teammate's
locally modified `make-client.js` is not part of this release until its actual
diff is reviewed and covered by tests. Preserve local adapter modifications before
upgrading. Notes describing those modifications are not sufficient to reproduce
them or claim support for the newer Files/Browser interface.
