// Expand test names in Node so the same complete suite runs on Windows and Unix.
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const directory = fileURLToPath(new URL('./', import.meta.url));
const names = new Set(['agent-skills.test.js', 'node-install.test.js', 'lazy-command-map.test.js',
  'update-check.test.js', 'desktop-runtime.test.js', 'connect-make.test.js']);
const tests = readdirSync(directory).filter(name => name.endsWith('.test.js') &&
  (name.startsWith('make-') || name.startsWith('cdp-') || names.has(name))).sort();
const result = spawnSync(process.execPath, ['--test', ...tests], {
  cwd: directory, shell: false, stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
