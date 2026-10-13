import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { program } from '../lib/cli-core.js';
import { MakeTransport } from '../make-transport.js';
import { MakeClient } from '../make-client.js';
import { decodeMakeSource } from '../make-source.js';
import { requireSessionOnly } from '../make-session.js';
import { driftExitCode } from '../make-drift.js';

const make = program.command('make')
  .description('Experimental direct source-file editing in Figma Make Desktop')
  .addHelpText('after', '\nAll Make commands accept --port PORT (global option). Use connection --save-port PORT to persist it.' +
    '\n\nReads (read, files, verify) see the open session\'s working copy. The original writes' +
    '\n(replace, create, import, remove) are session-only and require --session-only.' +
    '\nGit-mode write/delete use Make client VFS; save-version records a saved version.');

function report(value) { console.log(JSON.stringify(value, null, 2)); }
function failure(error) {
  console.error(JSON.stringify({ error: error.message,
    ...(error.endpoint ? { code: error.code, port: error.port, endpoint: error.endpoint, reason: error.reason, recovery: error.recovery } : {}),
    ...(error.backupPath ? { backupPath: error.backupPath } : {}),
    ...(error.code === 'MAKE_SESSION_ONLY_REQUIRED' ? { code: error.code } : {}),
    ...(error.sessionWrites ? { sessionWrites: error.sessionWrites, requestedPaths: error.requestedPaths, observedWrites: error.observedWrites } : {}) }));
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
function target(command, timeoutDefault = 15000) {
  return command.requiredOption('--file <key-or-url>', 'Exact open Make file key or URL')
    .option('--timeout <ms>', 'Maximum operation time', timeout, timeoutDefault);
}
// Make writes reach only the open session's working copy; refuse before
// connecting unless the caller accepted that with --session-only.
function sessionWrite(command) {
  return target(command).option('--session-only', 'Accept that the write is lost when the file is reopened unless saved in Make');
}
async function withClient(options, fn, write) {
  let client;
  try {
    if (write) requireSessionOnly(write, options);
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

target(make.command('ui').description('Report bounded Make workspace control metadata without reading source or selecting tabs'))
  .action(options => withClient(options, async client => report(await client.ui())));

target(make.command('preview').description('Inspect the running Make preview through the desktop connection'))
  .action(options => withClient(options, async client => report(await client.preview())));

target(make.command('files').description('Expand and list the source-file tree of the open session\'s working copy'))
  .action(options => withClient(options, async client => report(await client.files())));

target(make.command('diagnostics <path>').description('Read the selected source editor diagnostics when available'))
  .action((path, options) => withClient(options, async client => report(await client.diagnostics(path))));

target(make.command('read <path>').description('Read source and its SHA-256 from the open session\'s working copy through the filesystem bridge, at any depth'))
  .option('--remote', 'Require the filesystem bridge; never fall back to the editor buffer')
  .option('--out <local-file>', 'Write source to a new local file instead of stdout')
  .action((path, options) => withClient(options, async client => {
    const result = await client.read(path, { remote: options.remote });
    if (!options.out) return report(result);
    const outputPath = resolve(options.out);
    writeFileSync(outputPath, result.content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    const { content, ...metadata } = result;
    report({ ...metadata, bytes: Buffer.byteLength(content), outputPath });
  }));

sessionWrite(make.command('replace <path>').description('Session-only: back up and replace one existing source file at any depth in the open session\'s working copy, then read it back'))
  .requiredOption('--from <local-file>', 'UTF-8 source to write into the Make session')
  .requiredOption('--expected-sha256 <hash>', 'SHA-256 returned by the prior read; stale content is rejected')
  .option('--backup-dir <directory>', 'Local backup location (defaults to ~/.figma-cli/make-backups)')
  .action((path, options) => withClient(options, async client => {
    const bytes = sourceBytes(options.from);
    const content = decodeMakeSource(bytes);
    report(await client.replace(path, content, {
      expectedSha256: options.expectedSha256,
      backupDir: options.backupDir ? resolve(options.backupDir) : undefined,
    }));
  }, 'replace'));

sessionWrite(make.command('create <path>').description('Session-only: create one new UTF-8 source file in the open session\'s working copy; existing paths are rejected'))
  .requiredOption('--from <source>', 'Existing UTF-8 file, or - for stdin (no local copy required)')
  .action((path, options) => withClient(options, async client => {
    report(await client.importFiles([{ path, content: decodeMakeSource(sourceBytes(options.from)) }]));
  }, 'create'));

sessionWrite(make.command('import').description('Session-only: import new source files from a JSON manifest into the open session\'s working copy; never overwrite existing paths'))
  .requiredOption('--manifest <source>', 'JSON {files:[{path,content}]} file, or - for stdin')
  .action(options => withClient(options, async client => {
    const bytes = sourceBytes(options.manifest);
    if (bytes.length > 32 * 1024 * 1024) throw new Error('Make import manifest is limited to 32 MiB.');
    const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    report(await client.importFiles(manifest.files));
  }, 'import'));

sessionWrite(make.command('remove <path>').description('Session-only: back up and remove one exact text file from the open session\'s working copy after checking its SHA-256'))
  .requiredOption('--expected-sha256 <hash>', 'Expected original source hash; changed files are refused')
  .action((path, options) => withClient(options, async client => {
    report(await client.remove(path, { expectedSha256: options.expectedSha256 }));
  }, 'remove'));

target(make.command('verify').description('Compare the open session\'s working copy against a manifest; this does not prove the files were saved'))
  .requiredOption('--manifest <source>', 'JSON {files:[{path,content}]} file, or - for stdin')
  .action(options => withClient(options, async client => {
    const bytes = sourceBytes(options.manifest);
    if (bytes.length > 32 * 1024 * 1024) throw new Error('Make verification manifest is limited to 32 MiB.');
    const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    report(await client.verifyFiles(manifest.files));
  }));

target(make.command('drift').description('Read-only vendor inventory, manifest comparison and saved/pending-state check'), 120000)
  .requiredOption('--manifest <source>', 'VENDOR.json file, or - for stdin')
  .option('--receipt <file>', 'External receipt pinning the manifest and saved git SHA')
  .option('--root <path>', 'Vendor root in Make', 'src/vendor/atomic-aui')
  .option('--json', 'Print the complete machine-readable result')
  .action(options => withClient(options, async client => {
    const result = await client.drift(sourceBytes(options.manifest), {
      root: options.root, receiptBytes: options.receipt ? sourceBytes(options.receipt) : undefined,
    });
    if (options.json) report(result);
    else {
      console.log(`Make ${result.fileKey}: ${result.persistence?.mode || 'unknown'} mode, saved ${result.persistence?.savedVersion || 'unverified'}, pending ${result.persistence?.pendingCount ?? 'unknown'}`);
      console.log('Persistence scan: direct Make provider props, bounded at 100000 React fibers');
      console.log(`Vendor ${result.root}: ${Object.entries(result.counts).map(([status, count]) => `${status}=${count}`).join(' ')}`);
      console.log(`VENDOR.json: ${result.manifest.inMake?.sha256 || 'missing'} (${result.manifest.inMake?.bytes ?? 0} bytes)`);
      for (const file of result.files) {
        console.log(`${file.status}\t${file.path}\t${file.actual?.bytes ?? '-'}\t${file.actual?.sha256 ?? '-'}${file.expected ? `\texpected ${file.expected.bytes} ${file.expected.sha256}` : ''}`);
      }
      for (const reason of result.reasons) console.log(`drift: ${reason}`);
    }
    process.exitCode = driftExitCode(result);
  }));

target(make.command('write <path>').description('Write one git-mode Make file through Make client VFS; save-version is required to persist it'), 120000)
  .requiredOption('--from <source>', 'Existing UTF-8 file, or - for stdin')
  .option('--expected-sha256 <hash>', 'Required for an existing file; omit for a new file')
  .option('--backup-dir <directory>', 'Private backup directory for replaced content')
  .action((path, options) => withClient(options, async client => report(await client.writeDurable(path, decodeMakeSource(sourceBytes(options.from)), {
    expectedSha256: options.expectedSha256, backupDir: options.backupDir ? resolve(options.backupDir) : undefined,
  }))));

target(make.command('delete <path>').description('Delete one git-mode Make file through Make client VFS after backup; save-version is required'), 120000)
  .requiredOption('--expected-sha256 <hash>', 'Current SHA-256 of the file to remove')
  .option('--backup-dir <directory>', 'Private backup directory')
  .action((path, options) => withClient(options, async client => report(await client.deleteDurable(path, {
    expectedSha256: options.expectedSha256, backupDir: options.backupDir ? resolve(options.backupDir) : undefined,
  }))));

target(make.command('save-version').description('Save only the exact expected pending git-mode paths using Make createVersion'), 120000)
  .requiredOption('--title <title>', 'Make version title')
  .option('--expected-path <path>', 'One pending path; repeat for every expected path', (path, paths) => [...paths, path], [])
  .option('--receipt-out <path>', 'Write version ID, git SHA and changed-file set to a new private JSON file')
  .action(options => withClient(options, async client => {
    const outputPath = options.receiptOut ? resolve(options.receiptOut) : null;
    if (outputPath && existsSync(outputPath)) throw new Error('Receipt path already exists; no Make version was requested.');
    const result = await client.saveVersion(options.title, options.expectedPath);
    if (outputPath) {
      try {
        writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        result.receiptPath = outputPath;
      } catch (error) {
        report(result);
        throw new Error(`Make version was saved but the local receipt failed: ${error.message}`);
      }
    }
    report(result);
  }));
