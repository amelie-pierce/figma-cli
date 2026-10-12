import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { program } from '../lib/cli-core.js';
import { MakeTransport } from '../make-transport.js';
import { MakeClient } from '../make-client.js';
import { decodeMakeSource } from '../make-source.js';

const make = program.command('make')
  .description('Experimental direct source-file editing in Figma Make Desktop')
  .addHelpText('after', '\nAll Make commands accept --port PORT (global option). Use connection --save-port PORT to persist it.');

function report(value) { console.log(JSON.stringify(value, null, 2)); }
function failure(error) {
  console.error(JSON.stringify({ error: error.message,
    ...(error.endpoint ? { code: error.code, port: error.port, endpoint: error.endpoint, reason: error.reason, recovery: error.recovery } : {}),
    ...(error.backupPath ? { backupPath: error.backupPath } : {}),
    ...(error.acknowledged ? { acknowledged: error.acknowledged, requestedPaths: error.requestedPaths, observedWrites: error.observedWrites } : {}) }));
  process.exitCode = 1;
}
function sourceBytes(path) {
  if (path === '-' || path === '/dev/stdin') {
    process.stdin._handle?.setBlocking(true);
    return readFileSync(0);
  }
  return readFileSync(resolve(path));
}
function timeout(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 500 || n > 120000) throw new Error('Timeout must be 500–120000 milliseconds');
  return n;
}
function target(command) {
  return command.requiredOption('--file <key-or-url>', 'Exact open Make file key or URL')
    .option('--timeout <ms>', 'Maximum operation time', timeout, 15000);
}
async function withClient(options, fn) {
  let client;
  try {
    client = new MakeClient({ timeoutMs: options.timeout });
    await client.connect(options.file);
    await fn(client);
  } catch (error) { failure(error); }
  finally { client?.close(); }
}

make.command('list').description('List open Make projects on the configured desktop port')
  .action(async () => {
    try {
      report((await MakeTransport.listTargets()).map(({ fileKey, title, url }) => ({ fileKey, title, url })));
    } catch (error) { failure(error); }
  });

target(make.command('inspect').description('Inspect editor readiness without changing source'))
  .action(options => withClient(options, async client => report(await client.inspect())));

target(make.command('preview').description('Inspect the running Make preview through the desktop connection'))
  .action(options => withClient(options, async client => report(await client.preview())));

target(make.command('files').description('Expand and list the complete source-file tree'))
  .action(options => withClient(options, async client => report(await client.files())));

target(make.command('diagnostics <path>').description('Read the selected source editor diagnostics when available'))
  .action((path, options) => withClient(options, async client => report(await client.diagnostics(path))));

target(make.command('read <path>').description('Read a source file and its SHA-256'))
  .option('--remote', 'Read saved source through the filesystem bridge, including Markdown guidance')
  .option('--out <local-file>', 'Write source to a new local file instead of stdout')
  .action((path, options) => withClient(options, async client => {
    const result = await client.read(path, { remote: options.remote });
    if (!options.out) return report(result);
    const outputPath = resolve(options.out);
    writeFileSync(outputPath, result.content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const { content, ...metadata } = result;
    report({ ...metadata, bytes: Buffer.byteLength(content), outputPath });
  }));

target(make.command('replace <path>').description('Back up, replace one existing source file, and verify Make acknowledged saving'))
  .requiredOption('--from <local-file>', 'UTF-8 source to save into Make')
  .requiredOption('--expected-sha256 <hash>', 'SHA-256 returned by the prior read; stale content is rejected')
  .option('--backup-dir <directory>', 'Local backup location (defaults to ~/.figma-cli/make-backups)')
  .action((path, options) => withClient(options, async client => {
    const bytes = sourceBytes(options.from);
    const content = decodeMakeSource(bytes);
    report(await client.replace(path, content, {
      expectedSha256: options.expectedSha256,
      backupDir: options.backupDir ? resolve(options.backupDir) : undefined,
    }));
  }));

target(make.command('create <path>').description('Create one new UTF-8 Make source file; existing paths are rejected'))
  .requiredOption('--from <source>', 'Existing UTF-8 file, or - for stdin (no local copy required)')
  .action((path, options) => withClient(options, async client => {
    report(await client.importFiles([{ path, content: decodeMakeSource(sourceBytes(options.from)) }]));
  }));

target(make.command('import').description('Import new source files from a JSON manifest; never overwrite existing paths'))
  .requiredOption('--manifest <source>', 'JSON {files:[{path,content}]} file, or - for stdin')
  .action(options => withClient(options, async client => {
    const bytes = sourceBytes(options.manifest);
    if (bytes.length > 32 * 1024 * 1024) throw new Error('Make import manifest is limited to 32 MiB.');
    const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    report(await client.importFiles(manifest.files));
  }));

target(make.command('remove <path>').description('Back up and remove one exact text file after checking its SHA-256'))
  .requiredOption('--expected-sha256 <hash>', 'Expected original source hash; changed files are refused')
  .action((path, options) => withClient(options, async client => {
    report(await client.remove(path, { expectedSha256: options.expectedSha256 }));
  }));

target(make.command('verify').description('Read remote source files and compare exact contents against a manifest'))
  .requiredOption('--manifest <source>', 'JSON {files:[{path,content}]} file, or - for stdin')
  .action(options => withClient(options, async client => {
    const bytes = sourceBytes(options.manifest);
    if (bytes.length > 32 * 1024 * 1024) throw new Error('Make verification manifest is limited to 32 MiB.');
    const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    report(await client.verifyFiles(manifest.files));
  }));
