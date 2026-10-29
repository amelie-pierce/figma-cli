---
name: figma-make-team
description: Plain-language git for designers working on a team-mode Figma Make project's local clone. Maps phrases like "start a task", "save my progress", "get the latest", "fix the conflict", "I'm ready for review", "merge it", "what's going on?", "merge it anyway", the cross-review phrases "what needs my review", "review Bob's change", "approve it", "ask for changes", "show my review feedback" and "address the comments", and the admin deploy phrases "deploy", "what would deploy change" and "is the deploy done" to figma-cli team verbs and make deploy, and explains the result without git jargon. Use whenever a designer asks to branch, save, sync, review, merge, deploy or check the state of a prototype repo; never run raw git for them.
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
  other than its author. Never try to get around a refusal; explain it. The
  one exception is a repo admin saying "merge it anyway" (below), never on your
  own initiative.
- Never approve or ask for changes on the person's own pull request, and never
  edit, save or push from a review copy (`.figma-cli/reviews/pr-<n>`); the
  verbs refuse both. A review is recorded under the person's own GitHub login.
- Never resolve a conflict in another person's area by hand. `team conflicts`
  undoes and names the people to talk to; pass that on.
- Never put tokens or `.npmrc`/`.env` files into the repo. `team save` blocks
  them; tell the person to keep secrets in their own `~/.npmrc` or a git-ignored file.
- Do not write to Figma Make from this workflow. The only Make write in team
  mode is `figma-cli make deploy`, which only a repo admin can run (see
  "Deploying to Make" below).

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
| … and `TEAM_NO_BUILD_CHECK`, after they confirm merging without any build | `figma-cli team merge --no-build-check` | That no build confirmed it, so they should check the app on main |
| "Merge it anyway" / "merge without approval" (after `TEAM_NOT_APPROVED`) | First ask in plain words: "Why does this need to go in without a review? I'll record your reason in the history." Then `figma-cli team merge --force --reason "<their words>"` | That it was merged without a review, that their reason is recorded in the merge commit and the `receipt`, and that someone should still look at it afterwards. Only repo admins can; the build must still pass and the branch be up to date |
| "What's going on?" | `figma-cli team status` | Branch, unsaved files, review state, and how far behind main |

## Reviewing each other's work

A `<pr>` is the pull request's number or link, or the author's GitHub login.

| The person says | Run | Then tell them |
|---|---|---|
| "What needs my review?" | `figma-cli team reviews` | Each pull request (full URL), whose it is and why it is listed; their own open ones (`yours`) wait on someone else |
| "Review Bob's change" / "review #12" | `figma-cli team review bob` | The plain summary and files; offer to run it (`figma-cli make dev --dir <dir>` from the result, in the background) or open it in Lavish |
| "Open it so I can mark it up" | `figma-cli team review <pr> --lavish` | Lavish opened the change line by line; notes they send become comments |
| … "show me the app in Lavish" | `figma-cli team review <pr> --app` | Same, plus the built app. It runs the teammate's build code on their computer, like running it locally; ask first |
| "Comment: the padding is too tight" | `figma-cli team comment <pr> -m "<their words>"` | Posted, and where (a line or the whole pull request) |
| … on a file line | `figma-cli team comment <pr> -m "…" --file src/App.tsx --line 12` | Same; if it was not a changed line it became a general comment |
| "Approve it" / "looks good" | `figma-cli team approve <pr> [-m "<note>"]` | Approved as them; the author can now merge |
| "Ask for changes: …" | `figma-cli team request-changes <pr> -m "<what should change>"` | The author will see it in their feedback |
| "Show my review feedback" | `figma-cli team feedback` | Who approved, who asked for changes, and each comment in plain words. Their own comments are not listed; `authorCommentsHidden` says how many there are |
| "Address the comments" | `figma-cli team address` | They are back on their branch; work through `todo` with them, then `figma-cli team save` and `figma-cli team sync`, and ask the reviewer to look again |

**Always listening.** Whenever a result has `listen` (any verb that opened a
Lavish page for the person: `team review --lavish` or `--app` today, and any
later preview page), start every command in `listen.commands` right away as a
tracked background job of your harness, without asking: one that notifies you
when it ends, never `nohup`, `&` or a detached terminal. The person never has
to turn anything on. When a poll returns notes, act on them and start it again;
if it stops, times out or is killed, start it again. Stop only when it says the
person ended the session. If the person says "Listen to my review page again"
(the page tells them to, should Lavish ever show that the agent is not
listening), restart the poll for that page.

**Lavish notes.** Turn every note a poll returns into one `team comment`:
- A note on a line of the change page: pass its CSS locator,
  `--selector "<locator>"`; it maps to that file and line.
- A note on the app: pass `--selector "<locator>" --text "<quoted text>"`, and
  `--source <file:line>` only when the DOM snapshot shows a `data-source` on
  that element. Without one it is posted as a general comment quoting the
  locator; say so, since it is not pinned to a line.
Reply in Lavish with what you posted. A general remark goes in as-is.

## Deploying to Make (repo admins)

Merged `main` reaches the Make file only through `make deploy`, run in the clone
on an up-to-date `main` (`figma-cli make pull` first). `KEY` is the Make file key.

| The person says | Run | Then tell them |
|---|---|---|
| "What would deploy change?" | `figma-cli make deploy --file KEY` | The `summary` and files; nothing changed yet. Keep the `planPath` |
| "Deploy" / "deploy to Make" | First the dry run above, show it, then on their yes `figma-cli make deploy --file KEY --apply <planPath>` | The version saved and the `make-deploy/<n>` tag; that a check after a reload comes next |
| "Is the deploy done?" | `figma-cli make deploy --file KEY --verify <receiptPath>` | Whether Make holds that `main` after a fresh reload (`fresh-sandbox-verified`) |
| "Use current main to override Make" | First `figma-cli make deploy --file KEY --override-make` (add `--delete-make-only` only when requested); show counts, kept/deleted Make-only paths, overwritten-path hashes and digest. On their approval run `--apply <planPath> --confirm-override <first 12 digest>`, then `--verify <receiptPath>` after a fresh reload | The override backs up replaced/deleted paths before writing; the tag is pushed only after verification. A failed save can be aborted or resumed once; a created but unconfirmed version needs verify |
| … a deploy stopped part-way (`DEPLOY_WRITE_FAILED`) | Ask, then `--resume <receiptPath>` to finish, or `--abort <receiptPath>` to put Make back | Which; never run both |
| … the save outcome is unknown (`DEPLOY_SAVE_UNCERTAIN`) | `--verify <receiptPath>` only | Never save or deploy again before verify answers |

`DEPLOY_NOT_ADMIN`: only repo admins deploy; name who to ask. `DEPLOY_MAKE_AHEAD`:
someone edited Make directly; nothing was overwritten, and a developer must bring
those edits into `main` first. `DEPLOY_NOT_CURRENT`/`DEPLOY_NOT_MAIN`/`DEPLOY_DIRTY`:
run `figma-cli make pull` on a clean `main`. `DEPLOY_UNREVIEWED`: `main` must come
from a merged pull request. `DEPLOY_STALE_PLAN`/`DEPLOY_MAIN_MOVED`/`DEPLOY_TAG_CLASH`:
run a new dry run. `DEPLOY_SOLO`: the file has no repo, so there is nothing to deploy. `DEPLOY_UNSUPPORTED_PATH`:
Make cannot take new or deleted root files or new top-level folders; a developer
lists repo-only paths (docs, tests) and Make-only ones (Make's `AGENTS.md`) in
`.figma-cli/deploy-ignore` through a pull request. `DEPLOY_IGNORE`: that list is
not text; fix it the same way.

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
| `TEAM_BUILD_FAILED` / `TEAM_FORMAT_FAILED` | Nothing was saved (or, from `merge`, nothing merged); explain the error lines plainly and offer to fix the code. If the message says a task was started, they are on the new branch with their changes still unsaved |
| `TEAM_CONFLICT` | Their branch is unchanged. For each file, name the person and the pull request link from `conflicts[].changedBy`, and suggest asking on the pull request |
| `TEAM_PUSH_REJECTED` | GitHub has newer work on their branch (maybe another computer); their work is still saved here. Run `figma-cli team sync` to bring it in and send theirs |
| `TEAM_PUSH_BLOCKED` | GitHub flagged something (for example a secret) and refused it; quote GitHub's reason. Their unsent saves were undone and every change is still in their files, so help remove what was flagged, then run `figma-cli team save` again, or `figma-cli team sync` when the message says "get the latest" (after a sync had rewritten saves GitHub already has). Syncing alone, without removing it, will not help |
| `TEAM_NOT_APPROVED` | Someone other than them must approve the latest version of the pull request; share the link. A stale approval needs a fresh look. A repo admin may say "merge it anyway" |
| `TEAM_FORCE_NO_REASON` | Merging without a review needs their reason in plain words; ask for it |
| `TEAM_FORCE_NOT_ADMIN` | Only repo admins can merge without a review; a teammate has to approve it |
| `TEAM_FORCE_NEEDS_BUILD` | Even a merge without a review needs a passing build; do not combine it with `--no-build-check` |
| `TEAM_FORCE_PROTECTED` | GitHub's protection on the repo requires an approving review, and a merge without a review does not override it; ask a reviewer to approve |
| `TEAM_CHANGES_REQUESTED` | A reviewer asked for changes; help make them, then save |
| `TEAM_CHECKS_PENDING` / `TEAM_CHECKS_FAILED` | Wait for, or fix, the named checks |
| `TEAM_NO_BUILD_CHECK` | The pull request has no checks and the project no build script, so nothing proves it builds; ask whether to merge anyway |
| `TEAM_BEHIND_MAIN` | Main moved; their branch was brought up to date, so ask to merge again after checks rerun |
| `TEAM_NOTHING_TO_REVIEW` | No changes yet compared with main |
| `TEAM_OPERATION_IN_PROGRESS` | Something figma-cli did not start is unfinished in the clone; nothing changed. Ask a developer for help; never finish it yourself |
| `TEAM_SELF_REVIEW` | It is their own pull request; a teammate has to review it. Offer "show my review feedback" |
| `TEAM_REVIEW_OUTDATED` | The author saved newer changes since they looked; run `team review <pr>` again, then approve |
| `TEAM_REVIEW_COPY` | That folder is a review copy of someone else's work; nothing there is saved. Go back to the project clone |
| `TEAM_REVIEW_DIRTY` | The review copy has edits, so it was not updated; offer `team review <pr> --remove`, then review again |
| `TEAM_NO_PR` | Their branch has no open pull request yet; offer "I'm ready for review" |
| `TEAM_PR_NOT_FOUND` / `TEAM_AMBIGUOUS` / `TEAM_PR_CLOSED` | No such open pull request, or several by that person (list `choices`); ask which |
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
  (path glob → GitHub logins); `team pr` asks them to review. When nobody was
  asked (`noReviewerRequested` says why, for example no areas map), tell them
  to ask a teammate.
- `team save` keeps vendored files (under a `VENDOR.json`, or listed in it)
  exactly as they are, even when the project's format step would rewrite them.

Exact options and behaviour: `figma-cli team --help` and REFERENCE.md.
