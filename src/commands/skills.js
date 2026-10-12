import { program } from '../lib/cli-core.js';
import { manageSkills, skillsReady } from '../lib/agent-skills.js';

const skills = program.command('skills').description('Install or check bundled skills for Claude Code, Codex, and Copilot');
for (const action of ['install', 'status']) {
  skills.command(action)
    .description(action === 'install' ? 'Register all bundled skills without overwriting custom skills' : 'Check bundled skill registration and content')
    .option('--agent <name>', 'all | claude | codex | copilot', 'all')
    .action(({ agent }) => {
      try {
        const results = manageSkills({ install: action === 'install', agent });
        console.log(JSON.stringify({ ready: skillsReady(results), results }, null, 2));
        if (!skillsReady(results)) process.exitCode = 1;
      } catch (error) {
        console.error(JSON.stringify({ error: error.message }));
        process.exitCode = 1;
      }
    });
}
