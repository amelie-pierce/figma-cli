---
title: The team git layer for designers
description: How figma-cli team start/save/sync/conflicts/pr/merge/status keep designers off raw git, which rules are enforced in code, and where conflict and review decisions are made.
date: 2026-10-14
---

# The team git layer for designers

In team mode GitHub `main` is the source of truth and people work in a local clone ([local.md](local.md)). Designers are not expected to know git, so every branch, save, sync, pull request and merge is a `figma-cli team <verb>` (`src/commands/team.js:9`), backed by `src/make-team.js`. The skill `skills/figma-make-team/SKILL.md` maps their phrases to verbs and forbids improvised git. Nothing here reads or writes Figma.

## Where the rules live

`main` is unprotected on the team's GitHub plan, so the review rule is a convention enforced only by this code:
- **Own branch only.** `requireOwnBranch` (`src/make-team.js:175`) refuses `main`, a detached HEAD and any branch not prefixed `<gh-login>/`; the login comes from `gh api user` (`src/make-team.js:50`).
- **One push path.** `pushBranch` (`src/make-team.js:187`) is the only `git push`: an explicit `refs/heads/<b>:refs/heads/<b>` refspec, never `main`, and a force only as `--force-with-lease=<ref>:<exact sha>`. Tests fail any other push shape (`tests/make-team.test.js`, the fake runner).
- **Main is explicit.** `fetchMain` fetches `+refs/heads/main:refs/remotes/origin/main` (`src/make-team.js:218`), PRs pass `--base main`; the repo's default branch never matters.
- **Merge approval.** `reviewState` (`src/make-team.js:724`) counts an approval only when it is of the current head commit and comes from someone who is neither the PR author nor the person merging. gh's `latestReviews` JSON leaves the review commit empty, so reviews come from `gh api repos/<repo>/pulls/<n>/reviews` (`commit_id`, `src/make-team.js:640`). Fork PRs with the same branch name are ignored (`src/make-team.js:631`).

## Save

`save` (`src/make-team.js:385`) refuses secret-like files and token-looking content before running anything (`findSecrets`, `src/make-team.js:286`; findings are path and line only), then runs `package.json` `format` and `build` when present (`src/make-team.js:340`), re-checks, commits with `git add --all` and pushes. A remote branch with commits this clone lacks is refused, never overwritten.

## Sync and conflicts

`rebaseOntoMain` (`src/make-team.js:530`) runs `git rebase` onto `origin/main` with `merge.conflictStyle=merge`. Per stop it resolves only identical conflict blocks (`resolveIdenticalHunks`, `src/make-team.js:464`; git's own merge already collapses most) and `pnpm-lock.yaml`, by taking stage `:2:` (the `main` side during a rebase) and running `pnpm install --lockfile-only --ignore-scripts` (`src/make-team.js:517`). Anything else aborts the rebase, checks HEAD is back at the original commit, and names who else touched each file from `git log base..origin/main -- path`, mapped to a PR by `gh api repos/<repo>/commits/<sha>/pulls` or a squash subject's `(#n)` (`src/make-team.js:498`).

## Areas

`.figma-cli/project.json` may carry `areas` (path glob → logins). `parseAreas`/`globPattern` (`src/make-team.js:96`) drive the `save` warning for another person's area and the `pr` reviewer requests; a failed request only warns. Reviewers and owners are a convention; deploy rights are repo admin, not areas.

## Live proof (2026-10-14)

On `amelie-pierce/figma-testing-workflow` only: `status` on `main`, `start` (branch pushed with upstream), a `save` refused for `src/.npmrc`, a `save` that ran `format` and `build` and pushed 4 files, `pr` (template rendered, base `main`), and `merge` refused with `TEAM_NOT_APPROVED` (no second account, so no non-author approval). The test PR was closed and the branch deleted; `main` stayed at `7bc27ed`. The repo's `@make-kits` kit cannot install outside Make, so the proof installed with a git-excluded `.pnpmfile.cjs` that drops it; without an install, `save` refuses at the `format`/`build` step, which is the intended behaviour.

Tests: `tests/make-team.test.js` (real git against a bare origin; `gh` and `pnpm` faked).
