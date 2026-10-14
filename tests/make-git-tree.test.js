import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gitBlobSha, gitTreeSha, isIgnored, parseIgnore } from '../src/git-tree.js';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8',
  env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).trim();

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'figma-cli-git-tree-'));
  git(dir, 'init', '-q');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

// Names chosen to exercise git's tree ordering ('a' folder sorts as 'a/',
// after 'a-b' and 'a.b'), hidden paths, nesting, empty and binary content.
const FILES = {
  'a/x.txt': 'x\n', 'a-b': 'dash\n', 'a.b': 'dot\n', 'ab': '', '.figma-cli/project.json': '{"fileKey":"k"}\n',
  'src/App.tsx': 'export default 1;\n', 'src/deep/er/file.md': '# héllo\n', 'z/.hidden': 'h',
  'bin.dat': Buffer.from([0, 1, 2, 255, 10]),
};

describe('git object hashing', () => {
  it('matches git hash-object for blobs, including empty and binary', () => {
    const dir = fixture(FILES);
    try {
      for (const path of Object.keys(FILES)) {
        assert.equal(gitBlobSha(readFileSync(join(dir, path))), git(dir, 'hash-object', path), path);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('matches git write-tree for a nested tree', () => {
    const dir = fixture(FILES);
    try {
      git(dir, 'add', '-A');
      const files = Object.keys(FILES).map(path => ({ path, blob: gitBlobSha(readFileSync(join(dir, path))) }));
      assert.equal(gitTreeSha(files), git(dir, 'write-tree'));
      assert.equal(gitTreeSha([...files].reverse()), git(dir, 'write-tree'), 'input order does not matter');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('hashes the empty tree like git', () => {
    assert.equal(gitTreeSha([]), '4b825dc642cb6eb9a060e54bf8d69288fbee4904');
  });

  it('rejects duplicates, file/folder clashes and bad blobs', () => {
    const blob = gitBlobSha(Buffer.from('x'));
    assert.throws(() => gitTreeSha([{ path: 'a', blob }, { path: 'a', blob }]), /Duplicate/);
    assert.throws(() => gitTreeSha([{ path: 'a', blob }, { path: 'a/b', blob }]), /both a file and a folder/);
    assert.throws(() => gitTreeSha([{ path: 'a', blob: 'nope' }]), /Invalid git blob/);
  });
});

describe('git ignore rules', () => {
  it('selects the same files as git ls-files --exclude-standard', () => {
    const files = {
      '.gitignore': '# comment\n*.log\n/build\nnode_modules/\n!keep.log\ndocs/**/draft-*.md\n.env*\n',
      'app.log': 'x', 'keep.log': 'k', 'build/out.js': 'o', 'src/build/inner.js': 'i',
      'node_modules/pkg/index.js': 'n', 'docs/a/b/draft-1.md': 'd', 'docs/final.md': 'f',
      '.env.local': 's', 'src/App.tsx': 'a', 'src/.gitignore': 'secret.txt\n', 'src/secret.txt': 's',
      'other/secret.txt': 'o', '.npmrc': 'registry', '.figma/design-context/x.json': '{}', '.figma/make/kit.json': '{}',
    };
    const dir = fixture(files);
    try {
      writeFileSync(join(dir, '.git/info/exclude'), '.npmrc\n/.figma/design-context/\n');
      const expected = git(dir, 'ls-files', '--others', '--cached', '--exclude-standard').split('\n').sort();
      // Mirror the inventory: rules accumulate from info/exclude to the deepest .gitignore.
      const exclude = parseIgnore(readFileSync(join(dir, '.git/info/exclude'), 'utf8'));
      const kept = Object.keys(files).filter(path => {
        const parts = path.split('/');
        let rules = [...exclude, ...parseIgnore(files['.gitignore'])];
        for (let depth = 1; depth <= parts.length; depth++) {
          const prefix = parts.slice(0, depth).join('/');
          if (isIgnored(rules, prefix, depth < parts.length)) return false;
          if (depth < parts.length && files[`${prefix}/.gitignore`]) rules = [...rules, ...parseIgnore(files[`${prefix}/.gitignore`], prefix)];
        }
        return true;
      }).sort();
      assert.deepEqual(kept, expected);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
