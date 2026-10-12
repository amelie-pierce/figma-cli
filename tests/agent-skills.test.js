import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manageSkills, skillTargets, skillsReady, SKILLS_ROOT } from '../src/lib/agent-skills.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'figma-skills-test-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const sourceRoot = join(home, 'bundle');
  for (const name of ['figma-cli', 'figma-make']) {
    mkdirSync(join(sourceRoot, name, 'references'), { recursive: true });
    writeFileSync(join(sourceRoot, name, 'SKILL.md'), `---\nname: ${name}\ndescription: test\n---\n`);
    writeFileSync(join(sourceRoot, name, 'references', 'guide.md'), 'guide v1');
  }
  return { home, sourceRoot, env: {} };
}

test('installs all skills and supporting references in the three documented discovery roots', t => {
  const options = fixture(t);
  const result = manageSkills({ ...options, install: true });
  assert.equal(result.length, 6);
  assert.ok(skillsReady(result));
  for (const item of result) assert.equal(readFileSync(join(item.path, 'references/guide.md'), 'utf8'), 'guide v1');
  assert.deepEqual(skillTargets(options).map(([agent, path]) => [agent, path.slice(options.home.length).replaceAll('\\', '/')]), [
    ['claude', '/.claude/skills'], ['codex', '/.agents/skills'], ['copilot', '/.copilot/skills'],
  ]);
  assert.ok(manageSkills(options).every(x => x.status === 'up-to-date'));
});

test('status is read-only and selective installation honors Claude config', t => {
  const options = fixture(t);
  options.env.CLAUDE_CONFIG_DIR = join(options.home, 'custom-claude');
  assert.ok(manageSkills(options).every(x => x.status === 'missing'));
  assert.equal(existsSync(join(options.home, '.agents')), false);
  const result = manageSkills({ ...options, install: true, agent: 'claude' });
  assert.equal(result.length, 2);
  assert.ok(result.every(x => x.path.startsWith(options.env.CLAUDE_CONFIG_DIR)));
  assert.throws(() => manageSkills({ ...options, agent: 'typo' }), /Agent must/);
});

test('updates clean managed copies, but preserves user changes and added files', t => {
  const options = fixture(t);
  manageSkills({ ...options, install: true });
  writeFileSync(join(options.sourceRoot, 'figma-make/references/guide.md'), 'guide v2');
  const modified = join(options.home, '.claude/skills/figma-make/references/guide.md');
  writeFileSync(modified, 'my customization');
  writeFileSync(join(options.home, '.copilot/skills/figma-make/custom.md'), 'keep me');
  const results = manageSkills({ ...options, install: true });
  assert.equal(results.find(x => x.agent === 'codex' && x.name === 'figma-make').status, 'updated');
  assert.equal(results.filter(x => x.status === 'conflict').length, 2);
  assert.equal(readFileSync(modified, 'utf8'), 'my customization');
  assert.equal(readFileSync(join(options.home, '.copilot/skills/figma-make/custom.md'), 'utf8'), 'keep me');
  assert.equal(skillsReady(results), false);
});

test('preserves unmanaged directories, files, and foreign symlinks', t => {
  const options = fixture(t);
  const root = join(options.home, '.agents/skills');
  mkdirSync(join(root, 'figma-cli'), { recursive: true });
  writeFileSync(join(root, 'figma-cli/SKILL.md'), 'custom skill');
  symlinkSync(join(options.sourceRoot, 'figma-cli'), join(root, 'figma-make'), 'junction');
  assert.ok(manageSkills({ ...options, install: true, agent: 'codex' }).every(x => x.status === 'conflict'));
  rmSync(join(root, 'figma-make'));
  writeFileSync(join(root, 'figma-make'), 'not a directory');
  assert.ok(manageSkills({ ...options, install: true, agent: 'codex' }).every(x => x.status === 'conflict'));
  assert.equal(readFileSync(join(root, 'figma-cli/SKILL.md'), 'utf8'), 'custom skill');
});

test('accepts a link to this bundle without modifying its source', t => {
  const options = fixture(t);
  const root = join(options.home, '.agents/skills');
  mkdirSync(root, { recursive: true });
  symlinkSync(join(options.sourceRoot, 'figma-make'), join(root, 'figma-make'), 'junction');
  const result = manageSkills({ ...options, install: true, agent: 'codex' });
  assert.equal(result.find(x => x.name === 'figma-make').status, 'linked');
  assert.equal(existsSync(join(options.sourceRoot, 'figma-make/.figma-cli-skill.json')), false);
});

test('postinstall registers the real bundle and supports opt-out', t => {
  const { home } = fixture(t);
  const env = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, '.claude'), FIGMA_CLI_SKIP_SKILLS: '1' };
  const script = new URL('../src/install-skills.js', import.meta.url);
  let result = spawnSync(process.execPath, [fileURLToPath(script)], { env, encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(existsSync(join(home, '.agents')), false);
  env.FIGMA_CLI_SKIP_SKILLS = '0';
  result = spawnSync(process.execPath, [fileURLToPath(script)], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(skillsReady(manageSkills({ home, env, sourceRoot: SKILLS_ROOT })));
});
