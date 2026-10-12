import { manageSkills, skillsReady } from './lib/agent-skills.js';

// No Figma connection, patch, restart, or credentials are involved in installation.
if (process.env.FIGMA_CLI_SKIP_SKILLS !== '1') {
  try {
    const results = manageSkills({ install: true });
    for (const result of results) {
      console.error(`[figma-cli skills] ${result.agent}/${result.name}: ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
    }
    if (!skillsReady(results)) console.error('Some skills were preserved or could not be installed. Run figma-cli skills status, resolve the reported paths, then figma-cli skills install.');
  } catch (error) {
    console.error(`Skill registration incomplete: ${error.message}. Run figma-cli skills install to retry.`);
  }
}
