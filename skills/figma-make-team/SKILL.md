---
name: figma-make-team
description: Plain-language git for designers working on a team-mode Figma Make project's local clone. Maps phrases like "start a task", "save my progress", "get the latest", "fix the conflict", "I'm ready for review", "merge it" and "what's going on?" to figma-cli team verbs and explains the result without git jargon. Use whenever a designer asks to branch, save, sync, review, merge or check the state of a prototype repo; never run raw git for them.
---

# Figma Make team workflow

Designers on a team-mode Make project work in a local clone of the GitHub repo
(`figma-cli make clone`, see the figma-make skill). GitHub `main` is the source
of truth. Every git step is done by `figma-cli team <verb>`, which is tested,
deterministic code. Your job is to pick the verb from the person's words, run
it in the clone, and explain the JSON result in plain language.

## Hard rules

- **Never run git or gh yourself** for this work: no `git commit`, `push`,
  `rebase`, `merge`, `reset`, `stash`, `checkout`, `gh pr create` or `gh pr merge`.
  If no verb fits, say what is missing and stop. Read-only looks (`git log`,
  `git diff`) to explain something are fine.
- The verbs already refuse to push to `main`, force-push `main`, change another
  person's branch, or merge a pull request without an approval from someone
  other than its author. Never try to get around a refusal; explain it.
- Never resolve a conflict in another person's area by hand. `team conflicts`
  undoes and names the people to talk to; pass that on.
- Never put tokens or `.npmrc`/`.env` files into the repo. `team save` blocks
  them; tell the person to keep secrets in their own `~/.npmrc` or a git-ignored file.
- Do not write to Figma Make from this workflow. Deploying `main` to Make is a
  repo admin's separate step.

## Words to verbs

Run each verb inside the clone, or pass `--dir <clone>`.

| The person says | Run | Then tell them |
|---|---|---|
| "Start a task: *new filter panel*" | `figma-cli team start "new filter panel"` | The branch name, and that it starts from the latest main |
| … but they have unsaved changes (`TEAM_UNSAVED`) | Ask, then `figma-cli team start "<name>" --save-first` | Their changes were saved first (on main they move onto the new branch) |
| "Save my progress" | `figma-cli team save [-m "<short message>"]` | Which files were saved, in their words; that GitHub has them |
| "Get the latest" / "Sync with main" | `figma-cli team sync` | Whether anything new came in from main |
| "Fix the conflict" | `figma-cli team conflicts` | What was sorted out automatically, or who to talk to |
| "I'm ready for review" | `figma-cli team pr [--title "<title>"]` | The pull request link (full URL) and who was asked to review |
| "Merge it" | `figma-cli team merge` | The merged link, who approved, and that they are back on main |
| "What's going on?" | `figma-cli team status` | Branch, unsaved files, review state, and how far behind main |

Write a short, specific commit message from what you changed for them when you
know it (`-m "Tighten card padding"`); otherwise let `save` generate one.

## Explaining results

Every result has a `summary`; start from it and drop git words (rebase, HEAD,
upstream, lease). Mention warnings, for example a file in another person's area.
On failure the CLI prints `{error, code}` on stderr and exits 1:

| code | Say |
|---|---|
| `TEAM_ON_MAIN` | They are on main; offer to start a task |
| `TEAM_NOT_YOUR_BRANCH` | This branch belongs to someone else; nothing changed |
| `TEAM_UNSAVED` | List the files; offer to save first |
| `TEAM_SECRET` | Name each file (and line); ask them to remove the secret. Never print a value |
| `TEAM_LARGE_FILE` | The file is too big for the repo; make it smaller or keep it outside |
| `TEAM_BUILD_FAILED` / `TEAM_FORMAT_FAILED` | Nothing was saved; explain the error lines plainly and offer to fix the code |
| `TEAM_CONFLICT` | Their branch is unchanged. For each file, name the person and the pull request link from `conflicts[].changedBy`, and suggest asking on the pull request |
| `TEAM_PUSH_REJECTED` | GitHub has newer work on their branch (maybe another computer); check before syncing |
| `TEAM_NOT_APPROVED` | Someone other than them must approve the pull request first; share the link |
| `TEAM_CHANGES_REQUESTED` | A reviewer asked for changes; help make them, then save |
| `TEAM_CHECKS_PENDING` / `TEAM_CHECKS_FAILED` | Wait for, or fix, the named checks |
| `TEAM_BEHIND_MAIN` | Main moved; their branch was brought up to date, so ask to merge again after checks rerun |
| `TEAM_NOTHING_TO_REVIEW` | No changes yet compared with main |
| `TEAM_OPERATION_IN_PROGRESS` | Run `figma-cli team conflicts` to finish or undo it |
| `TEAM_GH_FAILED` | Ask them to run `gh auth login` (suggest `! gh auth login`) |
| `TEAM_NOT_A_CLONE` / `TEAM_NO_REPO` | Clone the project first with `figma-cli make clone OWNER/REPO` |

Always write pull request links as the full `https://` URL from the result.

## Good habits to nudge

- One task per branch, merged within about two days; `team status` says when
  main has moved on for over a day.
- Shared spots (`src/App.tsx`, `src/index.css`, `package.json`,
  `pnpm-lock.yaml`) are best changed in their own small pull request, and only
  one dependency pull request should be open at a time.
- Area owners come from the `areas` map in `.figma-cli/project.json`
  (path glob → GitHub logins); `team pr` asks them to review.

Exact options and behaviour: `figma-cli team --help` and REFERENCE.md.
