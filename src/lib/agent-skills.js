import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILLS_ROOT = fileURLToPath(new URL('../../skills/', import.meta.url));
const MARKER = '.figma-cli-skill.json';
const OWNER = 'amelie-pierce/figma-cli';

export function skillTargets({ home = homedir(), env = process.env, agent = 'all' } = {}) {
  const targets = {
    claude: join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'skills'),
    codex: join(home, '.agents', 'skills'),
    copilot: join(home, '.copilot', 'skills'),
  };
  if (agent !== 'all' && !Object.hasOwn(targets, agent)) throw new Error('Agent must be all, claude, codex, or copilot');
  return Object.entries(targets).filter(([name]) => agent === 'all' || agent === name);
}

// Include added files in the digest: a user extension must not be silently lost.
function digest(directory) {
  const hash = createHash('sha256');
  function walk(relative = '') {
    for (const name of readdirSync(join(directory, relative)).sort()) {
      if (!relative && name === MARKER) continue;
      const rel = relative ? `${relative}/${name}` : name;
      const full = join(directory, rel);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error(`Refusing skill containing a symlink: ${rel}`);
      hash.update(JSON.stringify([rel, stat.isDirectory() ? 'directory' : 'file']));
      if (stat.isDirectory()) walk(rel);
      else if (stat.isFile()) {
        const bytes = readFileSync(full);
        hash.update(String(bytes.length) + ':');
        hash.update(bytes);
      } else throw new Error(`Unsupported skill entry: ${rel}`);
    }
  }
  walk();
  return hash.digest('hex');
}

function inspect(source, destination) {
  let stat;
  try { stat = lstatSync(destination); } catch (error) {
    if (error.code === 'ENOENT') return { status: 'missing' };
    throw error;
  }
  if (stat.isSymbolicLink()) {
    try { if (realpathSync(source) === realpathSync(destination)) return { status: 'linked' }; } catch {}
    return { status: 'conflict', reason: 'Existing symlink belongs to another installation' };
  }
  if (!stat.isDirectory()) return { status: 'conflict', reason: 'Destination is not a directory' };
  let marker;
  try { marker = JSON.parse(readFileSync(join(destination, MARKER), 'utf8')); } catch {}
  if (marker?.owner !== OWNER) return { status: 'conflict', reason: 'Existing skill is not managed by this fork' };
  const actual = digest(destination);
  if (actual !== marker.sha256) return { status: 'conflict', reason: 'Installed skill has local modifications' };
  return { status: actual === digest(source) ? 'up-to-date' : 'outdated' };
}

export function manageSkills({ install = false, sourceRoot = SKILLS_ROOT, ...options } = {}) {
  const names = readdirSync(sourceRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(sourceRoot, entry.name, 'SKILL.md')))
    .map(entry => entry.name).sort();
  if (!names.length) throw new Error('No bundled skills found');
  const results = [];
  for (const [agent, root] of skillTargets(options)) {
    for (const name of names) {
      const source = join(sourceRoot, name);
      const destination = resolve(root, name);
      try {
        const before = inspect(source, destination);
        if (!install || !['missing', 'outdated'].includes(before.status)) {
          results.push({ agent, name, path: destination, ...before });
          continue;
        }
        mkdirSync(dirname(destination), { recursive: true });
        const staging = mkdtempSync(join(dirname(destination), '.figma-cli-install-'));
        const prepared = join(staging, 'new');
        const previous = join(staging, 'previous');
        let movedPrevious = false;
        try {
          const expected = digest(source);
          cpSync(source, prepared, { recursive: true, errorOnExist: true, force: false });
          if (digest(prepared) !== expected) throw new Error('Bundled skill changed during copying');
          writeFileSync(join(prepared, MARKER), JSON.stringify({ owner: OWNER, sha256: expected }) + '\n');
          // Recheck after preparing; do not replace edits made while copying.
          if (inspect(source, destination).status !== before.status) throw new Error('Destination changed during installation; retry after inspection');
          if (before.status === 'outdated') {
            renameSync(destination, previous);
            movedPrevious = true;
          }
          try { renameSync(prepared, destination); } catch (error) {
            if (movedPrevious) { renameSync(previous, destination); movedPrevious = false; }
            throw error;
          }
          results.push({ agent, name, path: destination, status: before.status === 'missing' ? 'installed' : 'updated' });
          rmSync(staging, { recursive: true });
        } catch (error) {
          // Preserve recovery data if rollback itself failed.
          if (movedPrevious && existsSync(previous)) error.message += `; recovery copy: ${previous}`;
          else rmSync(staging, { recursive: true, force: true });
          throw error;
        }
      } catch (error) {
        results.push({ agent, name, path: destination, status: 'error', reason: error.message });
      }
    }
  }
  return results;
}

export function skillsReady(results) {
  return results.length > 0 && results.every(({ status }) => ['installed', 'updated', 'up-to-date', 'linked'].includes(status));
}
