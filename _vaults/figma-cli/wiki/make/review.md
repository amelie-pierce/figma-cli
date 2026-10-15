---
title: Cross-review between designers
description: How figma-cli team reviews/review/comment/approve/request-changes/feedback/address work, where the no-self-approval and never-push-from-review rules live, and how Lavish notes map to pull request comments.
date: 2026-10-14
---

# Cross-review between designers

The review half of the team layer ([team.md](team.md)) lives in `src/make-team-review.js`; the CLI wiring is at the end of `src/commands/team.js`. Phrases map to verbs in `skills/figma-make-team/SKILL.md` ("Reviewing each other's work"). Nothing here reads or writes Figma.

## Rules and where they are enforced

- **No self-review.** `requireNotAuthor` (`src/make-team-review.js:74`) refuses `approve` and `request-changes` on the caller's own pull request (`TEAM_SELF_REVIEW`) before any GitHub write; GitHub would also refuse a self-approval, but the CLI never asks. Looking at your own pull request with `review` is allowed (it warns), and `reviews` lists your own open ones under `yours`, never under `needsReview`.
- **The reviewer never pushes to the author's branch.** The review copy is a detached worktree at `.figma-cli/reviews/pr-<n>` (`review`, `src/make-team-review.js:306`). `requireNotReviewCopy` (`src/make-team.js:253`) runs from `requireNoOperation`, `requireOwnBranch` and `pushBranch`, so `start`, `save`, `sync`, `conflicts`, `pr`, `merge` and `address` refuse there (`TEAM_REVIEW_COPY`), and `pushBranch` still pushes only `<login>/…` branches.
- **Approvals name a commit.** `decide` (`src/make-team-review.js:456`) posts `gh api POST repos/<repo>/pulls/<n>/reviews` with `commit_id` = the review copy's HEAD (or GitHub's head, with a warning, when there is no copy) and refuses a copy older than GitHub's head (`TEAM_REVIEW_OUTDATED`). `team merge` is unchanged: `reviewState` counts only current-head approvals from neither the author nor the merger ([team.md](team.md)).
- **Own login.** gh acts as the logged-in account; results report `as: @<login>` from `gh api user`, and a mismatch in GitHub's answer warns.

## Review copy

`review` fetches `+refs/heads/<head>:refs/remotes/origin/<head>` and requires it to equal `headRefOid` (`fetchHead`), so the copy is exactly what GitHub shows. `excludeReviews` adds `/.figma-cli/reviews/` to the clone's `info/exclude`; without it `team save`'s `git add --all` would stage the nested worktree. A rerun moves the copy to the new head unless it has edits outside `.lavish/` (`TEAM_REVIEW_DIRTY`); `--remove` runs `git worktree remove --force`. Install reuses `install` from `src/make-local.js` (frozen, `--ignore-scripts`, kit refusal) with `ignorePnpmfile`, since pnpm runs a repo's `.pnpmfile.cjs` even with `--ignore-scripts`; a failure only warns. No code from the pull request runs unless the reviewer asks: `make dev`, or `--app`, which runs its Vite config.

## Lavish mapping

Lavish's annotation locator walks up at most five elements and stops at the first `id` (its `selector()` in the lavish-axi bundle, checked 2026-10-14). So `reviewPage` (`src/make-team-review.js:169`) gives every diff line an `id` (`f<file>-R<new line>` or `-L<old line>`) and `data-source`, and writes `source-map.json` with the head it was made for; `reviewMap` ignores a map whose head is not the commit the comment goes on (a rerun without `--lavish` moves the copy but keeps the old map), so a note from an older page becomes a general comment quoting the locator instead of landing on the wrong line. `sourceFromSelector` takes the last known `#id` in a locator. App pages (the `make start` build at `.lavish/prototype/index.html`, or with `--app` a `vite build --base ./` with the entry inlined by `inlineBuild`, since the sandboxed frame blocks module loads) give locators without a mapped id, so those notes post as general comments quoting the locator, unless the agent passes a `--source` read from a `data-source` in Lavish's DOM snapshot.

`comment` (`src/make-team-review.js:404`) posts a line comment only when `commentable` says the line is in the pull request's diff (GitHub rejects others with 422); otherwise, or when GitHub still refuses, it posts a general comment that quotes the target.

## Limits

- Fork pull requests are refused; only same-repo branches are fetched.
- `reviews` reads each open pull request's reviews (one REST call per pull request), fine for a team's handful.
- Dynamic-import chunks of an app build are not inlined, so code-split apps may not run in Lavish; the change page always works.

## Live proof

On `amelie-pierce/figma-testing-workflow` only (2026-10-14), with one GitHub account: a test branch and pull request; `reviews` listed it under `yours` (the account's own); `review --lavish` made the detached copy at `.figma-cli/reviews/pr-<n>` (clone status clean, clone still on `main`), warned that the `@make-kits` kit cannot install, and opened 1 Lavish page; a `--selector` note on the review page posted a line comment on the changed line, a plain comment and an app-locator note posted as general comments; `approve` and `request-changes` were refused with `TEAM_SELF_REVIEW` (the PR kept 0 approvals); `save --dir <copy>` was refused with `TEAM_REVIEW_COPY`; `feedback` and `address` ran on the author side. The PR was closed, the branch deleted, the copy removed, and `main` stayed at `7bc27ed`. A two-account approval was not run live (no second account); tests cover it.

Tests: `tests/make-team-review.test.js` (two people, one bare origin, an in-memory GitHub; `gh`, `pnpm` and `lavish-axi` faked).
