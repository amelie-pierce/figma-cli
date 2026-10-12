import { program } from '../lib/cli-core.js';
import { getCdpSettings, parseCdpPort, saveCdpPort } from '../lib/cdp-config.js';
import { probeCdp } from '../lib/cdp-diagnostics.js';

program.command('connection')
  .description('Read-only CDP diagnostics, or save a local port; never patches or restarts Figma')
  .option('--save-port <number>', 'Persist the Desktop port for subsequent CLI invocations', parseCdpPort)
  .action(async options => {
    try {
      if (options.savePort !== undefined) {
        const saved = saveCdpPort(options.savePort);
        console.log(JSON.stringify({ saved, effective: getCdpSettings({ port: program.opts().port }),
          note: 'Port saved. No endpoint check or Figma restart was performed. --port and FIGMA_PORT override saved settings.' }, null, 2));
        return;
      }
      const result = await probeCdp({ port: program.opts().port });
      console.log(JSON.stringify(result, null, 2));
      if (!result.reachable || !result.figmaTarget) process.exitCode = 1;
    } catch (error) {
      console.error(JSON.stringify({ error: error.message }));
      process.exitCode = 1;
    }
  });
