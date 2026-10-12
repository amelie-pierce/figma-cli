// Dependency-free entry point: launch this file with Node or an IDE Node runner.
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { installFromNode } from './src/lib/node-install.js';

try {
  const { values } = parseArgs({ options: {
    agent: { type: 'string', default: 'all' },
    'npm-cli': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    console.log('Node installer: install.mjs [--agent all|claude|codex|copilot] [--npm-cli PATH_TO_NPM_CLI_JS]');
    console.log('Installs dependencies without lifecycle scripts, then registers and verifies skills. Does not connect to Figma.');
  } else {
    const result = installFromNode({
      root: fileURLToPath(new URL('./', import.meta.url)),
      agent: values.agent,
      npmCli: values['npm-cli'],
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ready) process.exitCode = 1;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
