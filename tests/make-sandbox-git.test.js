import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SandboxGit } from '../src/sandbox-git.js';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8',
  env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'Figma Make', GIT_AUTHOR_EMAIL: 'make@example.invalid',
    GIT_COMMITTER_NAME: 'Figma Make', GIT_COMMITTER_EMAIL: 'make@example.invalid' } }).trim();

// A repository whose history makes git store deltas when it repacks.
function repository() {
  const dir = mkdtempSync(join(tmpdir(), 'figma-cli-sandbox-git-'));
  git(dir, 'init', '-q', '-b', 'main');
  const lines = Array.from({ length: 400 }, (_, i) => `export const line${i} = ${i};`);
  for (let round = 0; round < 4; round++) {
    lines[round * 7] = `export const changed${round} = true;`;
    const files = { 'src/App.tsx': lines.join('\n'), '.figma/make/dev': '#!/bin/sh\npnpm dev\n',
      [`src/round-${round}.ts`]: `export default ${round};\n`, 'README.md': `# Round ${round}\n` };
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    chmodSync(join(dir, '.figma/make/dev'), 0o755);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', `fs write: ${round}`);
  }
  return dir;
}

const io = dir => ({
  readFile: async path => existsSync(join(dir, '.git', path)) ? readFileSync(join(dir, '.git', path)) : null,
  listDir: async path => existsSync(join(dir, '.git', path)) ? readdirSync(join(dir, '.git', path)) : null,
});

async function assertMatchesGit(dir) {
  const reader = new SandboxGit(io(dir));
  const head = await reader.head();
  assert.equal(head, git(dir, 'rev-parse', 'HEAD'));
  for (const commit of git(dir, 'rev-list', 'HEAD').split('\n')) {
    const tree = await reader.commitTree(commit);
    assert.equal(tree, git(dir, 'rev-parse', `${commit}^{tree}`));
    const expected = git(dir, 'ls-tree', '-r', tree).split('\n').map(line => {
      const [meta, path] = line.split('\t');
      const [mode, , blob] = meta.split(' ');
      return [path, { mode, blob }];
    });
    assert.deepEqual([...(await reader.flatten(tree))].sort(), expected.sort());
  }
}

describe('sandbox git object reader', () => {
  it('reads loose commits and trees, with modes, exactly as git ls-tree', async () => {
    const dir = repository();
    try { await assertMatchesGit(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('reads packed and deltified objects through packed-refs', async () => {
    const dir = repository();
    try {
      git(dir, 'repack', '-adf', '--depth=50', '--window=250');
      git(dir, 'pack-refs', '--all');
      git(dir, 'prune-packed');
      assert.ok(git(dir, 'verify-pack', '-v', ...readdirSync(join(dir, '.git/objects/pack')).filter(n => n.endsWith('.idx'))
        .map(n => join(dir, '.git/objects/pack', n))).includes('chain length'), 'the fixture must contain deltas');
      await assertMatchesGit(dir);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('fails closed on missing or corrupted objects', async () => {
    const dir = repository();
    try {
      const reader = new SandboxGit(io(dir));
      await assert.rejects(reader.object('0'.repeat(40)), /missing/);
      const head = git(dir, 'rev-parse', 'HEAD');
      const tampered = new SandboxGit({ ...io(dir), readFile: async path => path.startsWith('objects/')
        ? (await io(dir).readFile(`objects/${git(dir, 'rev-parse', 'HEAD^{tree}').slice(0, 2)}/${git(dir, 'rev-parse', 'HEAD^{tree}').slice(2)}`))
        : io(dir).readFile(path) });
      await assert.rejects(tampered.commitTree(head), /hash check|not a commit/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
