import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Warn-only reminders around a team-mode `make deploy`. None of them changes
// an exit code, refuses anything or writes to Make. Each one stays silent
// when figma-cli cannot know its condition.

const SHA = /^[a-f0-9]{40}$/;
const short = sha => String(sha).slice(0, 7);
const STALE_TAB = 'The open Make tab is behind Make: its saved baseline is stale. Close the Make file and open it again';

// After a version is saved, every other open tab still holds the older one.
export function reloadReminder(warn, version) {
  warn(`Make saved version ${version.versionNumber ?? short(version.gitSha)}. Everyone who has this Make file open should reload it now, ` +
    'so no open tab stays behind Make.');
}

// Make's change tracker failed, or the saved pointer this tab reports is no
// longer in Make's sandbox.
export function staleTabNotice(warn, status) {
  const state = status?.persistence;
  if (state?.mode !== 'git' || !(state.error || status.savedMissing)) return;
  warn(`Make's change tracker in this tab ${state.error ? 'reports an error' : 'names a saved version the sandbox no longer has'}. ` +
    `${STALE_TAB}, then run this command again.`);
}

// After Make refused a save before creating a version: when the tracker now
// reports an error, or Make's saved pointer moved off the one the deploy
// started from, the refusal came from a stale baseline. An unreadable state
// says nothing.
export async function staleSaveNotice(client, receipt, warn) {
  let state;
  try { state = (await client.idleState([]))?.state; }
  catch { return; }
  if (state?.mode !== 'git') return;
  const moved = SHA.test(state.savedVersion || '') && state.savedVersion !== receipt.makeBefore?.versionGitSha;
  if (!state.error && !moved) return;
  warn(`Make refused the save from a stale baseline. ${STALE_TAB} before you run --resume or --abort ${receipt.receiptPath}.`);
}

// Commits the make-deploy tags on GitHub point at, from `git ls-remote`
// output (an annotated tag's peeled ^{} line names its commit).
export function tagCommits(lsRemote) {
  const direct = new Map();
  const peeled = new Map();
  for (const line of String(lsRemote).split('\n').filter(Boolean)) {
    const [sha, ref] = line.split('\t');
    const match = /^refs\/tags\/(make-deploy\/\d+)(\^\{\})?$/.exec(ref || '');
    if (match && SHA.test(sha)) (match[2] ? peeled : direct).set(match[1], sha);
  }
  return new Set([...direct].map(([name, sha]) => peeled.get(name) ?? sha));
}

// Make's newest saved version, when a receipt on this machine shows a deploy
// saved it: the deploy named it "deploy <sha7>". Make's version history lists
// AI turns only, so without such a receipt the name is unknown.
function deployedVersion(dir, fileKey, savedVersion) {
  if (!SHA.test(savedVersion || '') || !existsSync(dir)) return null;
  for (const name of readdirSync(dir).filter(entry => entry.endsWith('.json'))) {
    try {
      const receipt = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (receipt?.fileKey === fileKey && receipt.makeAfter?.versionGitSha === savedVersion && SHA.test(receipt.mainCommit || '')) {
        return { ...receipt, receiptPath: join(dir, name) };
      }
    } catch { /* not a receipt */ }
  }
  return null;
}

// Warn when Make's newest version is a deploy ("deploy <sha7>") that has no
// make-deploy tag on GitHub for its commit: make status and the next deploy
// compare against the newest tag, so they do not know that version.
export function untaggedDeployNotice(warn, { dir, fileKey, status, ctx }) {
  const receipt = deployedVersion(dir, fileKey, status?.persistence?.savedVersion);
  if (!receipt) return;
  const listed = ctx.tryGit(['ls-remote', '--tags', 'origin', 'refs/tags/make-deploy/*']);
  if (listed?.status !== 0) return;
  if (tagCommits(listed.stdout).has(receipt.mainCommit)) return;
  warn(`Make's newest version "deploy ${short(receipt.mainCommit)}" has no make-deploy tag on GitHub for main ${short(receipt.mainCommit)}, ` +
    `so make status and the next deploy compare against an older tag. Its receipt is ${receipt.receiptPath} (stage ${receipt.stage}).`);
}
