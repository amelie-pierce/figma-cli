import { dirname } from 'node:path';

// Opening a Lavish page for a designer, and keeping the agent listening to it.
// A designer's notes reach the agent only while `lavish-axi poll <page>` runs,
// and Lavish hands poll results only to the process that polls (it forbids
// detached nohup/& pollers). So figma-cli cannot listen on the agent's behalf:
// every result that opens a page carries a `listen` contract, and the agent
// starts it at once as a tracked background job and restarts it whenever it
// stops, with nothing for the designer to do. The figma-make-team skill holds
// the agent to it. Every page figma-cli opens goes through openPages.

export const LISTEN_RULE = 'Start every command in "commands" right now as a tracked background job of your harness (one that notifies you when it ends; ' +
  'never nohup, & or a detached terminal), without asking the designer. When one returns notes, act on them and start it again. If one stops, ' +
  'times out or is killed, start it again. Stop only when it says the designer ended the session.';

// What the designer types to their agent if Lavish ever shows that nobody is listening.
export const RELISTEN_PHRASE = 'Listen to my review page again';
export const NOT_LISTENING_HELP = `Your agent listens to this page on its own. If Lavish ever says the agent is not listening, type this to your agent: "${RELISTEN_PHRASE}".`;

export const listenContract = pages => ({ auto: true, commands: pages.map(page => `lavish-axi poll ${JSON.stringify(page)}`), rule: LISTEN_RULE });

function open(page, { run, warn }) {
  const result = run('lavish-axi', [page], { cwd: dirname(page) });
  if (result.status === 127) { warn(`lavish-axi is not installed; open ${page} in a browser instead.`); return false; }
  if (result.status !== 0) { warn(`lavish-axi could not open ${page}: ${(result.stderr || result.stdout).trim().split('\n').pop()}`); return false; }
  return true;
}

// Open each page in Lavish; return what opened and the listener to start.
export function openPages(pages, { run, warn = () => {} }) {
  const opened = pages.filter(p => open(p.page, { run, warn }));
  return { pages, opened: opened.length, ...(opened.length ? { listen: listenContract(opened.map(p => p.page)) } : {}) };
}

// The line a CLI prints (on stderr) when a result asks its agent to listen.
export const listenNotice = listen => listen?.auto
  ? `agent: keep listening to the designer, starting now as tracked background jobs: ${listen.commands.join(' ; ')}. ${listen.rule}`
  : null;
