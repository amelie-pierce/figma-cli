import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { requireGitMode } from './make-durable.js';
import { differingPaths, forgetLinkedRepo, ghRunner, linkedRepo, parseMarker, PROJECT_MARKER, recordLinkedRepo, repoName } from './make-project.js';

// `make mode team|solo`: the only path that adds or removes the team-mode
// marker. It skips the team-mode write gate, so it touches exactly the marker,
// saves that as its own version, verifies it after a page reload and records a
// local receipt.

export const MODE_TOGGLE_PATHS = Object.freeze([PROJECT_MARKER]);
export const CONFIRM_FLAG = '--yes-turn-off-team-mode';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const fail = (message, code) => { const error = new Error(message); if (code) error.code = code; throw error; };

// Canonical marker bytes: no secrets, no personal data.
export function markerContent(fileKey, repo) {
  return `${JSON.stringify({ fileKey, repo: repoName(repo), trunk: 'main' }, null, 2)}\n`;
}

// The gate exemption: a mode change may name the marker and nothing else.
export function requireModeTogglePaths(paths) {
  if (!Array.isArray(paths) || JSON.stringify(paths) !== JSON.stringify(MODE_TOGGLE_PATHS)) {
    fail(`make mode changes only ${PROJECT_MARKER}; refused ${JSON.stringify(paths)}.`, 'MAKE_MARKER_RESERVED');
  }
  return paths;
}

export const soloWarning = repo => `Turning team mode off for a file linked to ${repo}. Make stops deploying only from ${repo} main: ` +
  'every figma-cli write goes straight to Make again, and Make and the repo can drift apart. Only a repo admin may do this.';

// Decide what a mode change does from Make's state before it. Pure: no I/O.
// `status` is client.projectStatus(); `vfsMarker` is the marker as Make's
// client VFS holds it, which must agree with the sandbox's copy.
export function planModeChange({ action, fileKey, repo, status, vfsMarker, firstVersion = false, since }) {
  if (!['team', 'solo'].includes(action)) fail('Mode must be team or solo.');
  const sandboxMarker = status.markerBytes ?? null;
  if ((vfsMarker == null) !== (sandboxMarker == null) || (vfsMarker && !Buffer.from(vfsMarker).equals(Buffer.from(sandboxMarker)))) {
    fail(`Make client VFS and sandbox disagree on ${PROJECT_MARKER}; nothing was changed.`);
  }
  const state = requireGitMode(status.persistence, { firstVersion });
  if (state.pendingPaths?.length) {
    fail(`Make has other pending changes ${JSON.stringify(state.pendingPaths)}; save or discard them first.`, 'MAKE_MODE_OTHER_PENDING');
  }
  if (firstVersion && status.treeSource !== 'sandbox-head') fail('Make sandbox HEAD was not readable as the first-version base.');
  if (!firstVersion && status.treeSource !== 'saved-version') fail('Make saved version was not the comparison base.');
  if (since != null && !firstVersion) fail('--since applies only with --first-version.');
  if (since != null && !/^[a-f0-9]{40}$/.test(since)) fail('--since must be a full 40-character commit SHA.');

  // With a baseline, the working copy may differ from the saved tree only in
  // the marker. Without one, the save checks the difference from `since`.
  const unsaved = firstVersion ? [] : differingPaths(status.makeFlat, status.workingFlat);
  const others = unsaved.filter(path => path !== PROJECT_MARKER);
  if (others.length) fail(`Make has ${others.length} other unsaved path(s) ${JSON.stringify(others)}; save or discard them first.`, 'MAKE_MODE_OTHER_PENDING');
  const markerUnsaved = unsaved.includes(PROJECT_MARKER);
  const marker = parseMarker(sandboxMarker, fileKey);
  const plan = { action, fileKey, firstVersion, since: firstVersion ? since ?? status.head : null, sandboxHead: status.head,
    previousGitSha: state.savedVersion ?? null, paths: [...MODE_TOGGLE_PATHS] };

  if (action === 'team') {
    repoName(repo);
    const content = markerContent(fileKey, repo);
    if (marker.state === 'mismatch') fail(`${marker.reason}; nothing was changed.`, 'MAKE_MODE_MISMATCH');
    if (marker.state === 'invalid') fail(`${marker.reason}. Remove it with make mode solo first.`, 'MAKE_MARKER_INVALID');
    if (marker.state === 'valid') {
      if (marker.repo !== repo || marker.trunk !== 'main') {
        fail(`Team mode already names ${marker.repo} (${marker.trunk}). Turn it off with make mode solo first.`, 'MAKE_MODE_MISMATCH');
      }
      // Present but never saved: save what is there. Saved: nothing to do.
      if (!markerUnsaved && !firstVersion) fail(`Team mode is already on for ${repo}; nothing was changed.`, 'MAKE_MODE_UNCHANGED');
      if (firstVersion && since == null) {
        fail(`${PROJECT_MARKER} is already in the working copy of a never-saved file; pass --since with the sandbox head from before it was written.`);
      }
      return { ...plan, repo, write: false, content: Buffer.from(sandboxMarker).toString('utf8'), markerSha256: sha256(sandboxMarker) };
    }
    return { ...plan, repo, write: true, content, markerSha256: sha256(content) };
  }

  if (repo != null) fail('make mode solo takes the repo from the marker; drop --repo.');
  if (marker.state === 'absent') {
    // Removed but never saved: save the removal. Otherwise nothing to do.
    if (!markerUnsaved && !firstVersion) fail('Team mode is already off; nothing was changed.', 'MAKE_MODE_UNCHANGED');
    if (firstVersion && since == null) fail(`No ${PROJECT_MARKER} is in the working copy; team mode is already off.`, 'MAKE_MODE_UNCHANGED');
    return { ...plan, repo: null, delete: false };
  }
  return { ...plan, repo: marker.repo ?? rawRepo(sandboxMarker), delete: true, removedMarkerSha256: sha256(sandboxMarker),
    expectedSha256: sha256(Buffer.from(sandboxMarker).toString('utf8')) };
}

// An unusable marker may still name a repo; its admins decide its removal.
function rawRepo(bytes) {
  try { return repoName(JSON.parse(Buffer.from(bytes).toString('utf8')).repo); } catch { return null; }
}

// Read-only GitHub checks through the caller's gh login (GET requests only).
export async function readRepoAccess(repo, { gh = ghRunner() } = {}) {
  const info = await gh([`repos/${repoName(repo)}`]);
  let login = null;
  try { login = (await gh(['user'])).login || null; } catch { /* identity is informational */ }
  const p = info?.permissions || {};
  const permission = p.admin ? 'admin' : p.maintain ? 'maintain' : p.push ? 'write' : p.triage ? 'triage' : p.pull ? 'read' : 'none';
  return { login, permission };
}

export const receiptDir = (home = homedir()) => join(home, '.figma-cli', 'mode-receipts');

export function writeModeReceipt(receipt, { home } = {}) {
  const dir = receiptDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${receipt.at.replace(/[:.]/g, '-')}-${receipt.fileKey}-${receipt.action}.json`);
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return path;
}

// After a reload, Make must report the new version as its clean baseline, the
// saved tree must hold exactly the planned marker (or none), and the client
// VFS and sandbox must agree with it.
export function verifyModeAfterReload(plan, version, status, vfsMarker) {
  const problems = [];
  const state = status.persistence;
  if (state?.mode !== 'git' || !state.hasBaseline || state.savedVersion !== version.gitSha || state.pendingCount !== 0) {
    problems.push(`Make reports saved ${state?.savedVersion ?? 'none'} with ${state?.pendingCount ?? 'unknown'} pending, not a clean ${version.gitSha}`);
  }
  if (status.treeSource !== 'saved-version' || status.makeTree !== version.tree) problems.push(`saved tree ${status.makeTree} is not ${version.tree}`);
  if (status.workingTree !== status.makeTree) problems.push('working copy differs from the saved tree');
  const saved = status.makeFlat?.get(PROJECT_MARKER);
  const sandbox = status.markerBytes == null ? null : sha256(status.markerBytes);
  const vfs = vfsMarker == null ? null : sha256(vfsMarker);
  const expected = plan.action === 'team' ? plan.markerSha256 : null;
  if (plan.action === 'team' ? !saved : !!saved) problems.push(`saved tree ${plan.action === 'team' ? 'lacks' : 'still holds'} ${PROJECT_MARKER}`);
  if (sandbox !== expected) problems.push(`sandbox ${PROJECT_MARKER} is ${sandbox ?? 'absent'}`);
  if (vfs !== expected) problems.push(`client VFS ${PROJECT_MARKER} is ${vfs ?? 'absent'}`);
  if (problems.length) fail(`Make mode change was saved as version ${version.versionNumber} (${version.gitSha}) but did not verify after reload: ${problems.join('; ')}.`);
  return 'reloaded; clean-baseline; saved-tree-and-marker-matched';
}

// Run a mode change. `client` is a connected MakeClient (or a fake with the
// same methods); `confirm` is the --yes-turn-off-team-mode flag.
export async function runModeChange(client, { action, repo, firstVersion = false, since, dryRun = false, confirm = false },
  { gh = ghRunner(), home, warn = message => console.error(`warning: ${message}`), now = () => new Date() } = {}) {
  const fileKey = client.fileKey;
  const status = await client.projectStatus();
  const plan = planModeChange({ action, fileKey, repo, status, vfsMarker: await client.projectMarker(), firstVersion, since });
  requireModeTogglePaths(plan.paths);
  // Saving a removal that an earlier run left unsaved: the marker is gone from
  // the working copy, so the repo whose admins decide comes from the local link
  // that run kept. Without it, refuse rather than skip the admin check.
  if (action === 'solo' && !plan.delete) {
    plan.repo = linkedRepo(fileKey, { home });
    if (!plan.repo) fail(`${PROJECT_MARKER} was removed but not saved, and no linked repo is recorded to check admin rights against. Nothing was changed.`, 'MAKE_MODE_NOT_ADMIN');
  }

  let access = null;
  if (plan.delete && !plan.repo) warn(`${PROJECT_MARKER} names no readable repo, so no repo admin check is possible.`);
  if (plan.repo) {
    if (action === 'solo') warn(soloWarning(plan.repo));
    try { access = await readRepoAccess(plan.repo, { gh }); }
    catch (error) { fail(`Cannot read ${plan.repo} through gh: ${error.message}. Nothing was changed.`, action === 'solo' ? 'MAKE_MODE_NOT_ADMIN' : undefined); }
    if (action === 'solo' && access.permission !== 'admin') {
      fail(`Only an admin of ${plan.repo} may turn team mode off; your permission is ${access.permission}. Nothing was changed.`, 'MAKE_MODE_NOT_ADMIN');
    }
  }
  const summary = { action, fileKey, repo: plan.repo, firstVersion, since: plan.since, path: PROJECT_MARKER,
    change: action === 'team' ? (plan.write ? 'write' : 'save-existing') : (plan.delete ? 'delete' : 'save-removal'),
    ...(plan.markerSha256 ? { markerSha256: plan.markerSha256 } : {}),
    ...(plan.removedMarkerSha256 ? { removedMarkerSha256: plan.removedMarkerSha256 } : {}),
    ...(access ? { who: access.login, permission: access.permission } : {}) };
  if (dryRun) return { dryRun: true, ...summary };
  // Turning team mode off is deliberate, linked repo or not.
  if (action === 'solo' && !confirm) {
    fail(`Turning team mode off needs ${CONFIRM_FLAG}. Nothing was changed.`, 'MAKE_MODE_CONFIRM_REQUIRED');
  }

  let change = null;
  if (plan.write) change = await client.writeDurable(PROJECT_MARKER, plan.content, { firstVersion });
  if (plan.delete) change = await client.deleteDurable(PROJECT_MARKER, { expectedSha256: plan.expectedSha256, firstVersion });
  const title = action === 'team' ? `figma-cli: team mode on (${plan.repo})` : 'figma-cli: team mode off';
  let version;
  try { version = await client.saveCheckedVersion(title, requireModeTogglePaths(plan.paths), { firstVersion, since: plan.since ?? undefined }); }
  catch (error) {
    if (!error.version) {
      error.message += ` ${PROJECT_MARKER} is ${action === 'team' ? 'written' : 'removed'} but unsaved; run make mode ${action} again` +
        `${firstVersion ? ` with --first-version --since ${plan.since}` : ''} to save it.`;
    }
    throw error;
  }

  const receipt = { schema: 'figma-cli/make-mode-receipt@1', at: now().toISOString(), who: access?.login ?? null, action,
    fileKey, repo: plan.repo, firstVersion, path: PROJECT_MARKER, change: summary.change,
    ...(plan.markerSha256 ? { markerSha256: plan.markerSha256 } : {}),
    ...(plan.removedMarkerSha256 ? { removedMarkerSha256: plan.removedMarkerSha256 } : {}),
    version: { id: version.versionId, number: version.versionNumber, gitSha: version.gitSha, previousGitSha: version.previousGitSha },
    tree: version.tree, ...(change?.backupPath ? { backupPath: change.backupPath } : {}) };
  let verification;
  try {
    await client.reloadPage();
    verification = verifyModeAfterReload(plan, version, await client.projectStatus(), await client.projectMarker());
  } catch (error) {
    error.version = version;
    try { error.receiptPath = writeModeReceipt({ ...receipt, verification: 'failed', error: error.message }, { home }); }
    catch (receiptError) { error.message += ` The local receipt also failed: ${receiptError.message}`; }
    throw error;
  }
  if (action === 'team') recordLinkedRepo(fileKey, plan.repo, { home });
  const unlinked = action === 'solo' ? forgetLinkedRepo(fileKey, { home }) : false;
  const receiptPath = writeModeReceipt({ ...receipt, verification }, { home });
  return { ...summary, versionId: version.versionId, versionNumber: version.versionNumber, gitSha: version.gitSha,
    previousGitSha: version.previousGitSha, tree: version.tree, verification, receiptPath,
    ...(action === 'solo' ? { localLinkRemoved: unlinked } : {}) };
}
