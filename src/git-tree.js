import { createHash } from 'node:crypto';

// Git object hashing and ignore rules, computed exactly as git does, so a Make
// working-copy tree SHA can be compared with a GitHub tree SHA.

const sha1 = (...parts) => {
  const hash = createHash('sha1');
  for (const part of parts) hash.update(part);
  return hash.digest('hex');
};

export function gitBlobSha(bytes) {
  if (!Buffer.isBuffer(bytes)) throw new Error('Git blob hashing needs bytes.');
  return sha1(`blob ${bytes.length}\0`, bytes);
}

// Git orders tree entries by name bytes, comparing a subtree as if its name
// ended with '/'.
const entryKey = entry => Buffer.from(entry.type === 'tree' ? `${entry.name}/` : entry.name, 'utf8');

function hashTree(node) {
  const entries = [...node.entries()].map(([name, child]) => child instanceof Map
    ? { name, type: 'tree', mode: '40000', sha: hashTree(child) }
    : { name, type: 'blob', mode: child.mode, sha: child.sha });
  entries.sort((a, b) => Buffer.compare(entryKey(a), entryKey(b)));
  const body = Buffer.concat(entries.map(entry => Buffer.concat([
    Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'), Buffer.from(entry.sha, 'hex'),
  ])));
  return sha1(`tree ${body.length}\0`, body);
}

// files: [{ path: 'src/App.tsx', blob: '<40 hex>', mode?: '100644' }]. Empty
// directories do not exist in git, so only files are listed.
export function gitTreeSha(files) {
  const root = new Map();
  for (const { path, blob, mode = '100644' } of files) {
    if (!/^[a-f0-9]{40}$/.test(blob || '')) throw new Error(`Invalid git blob SHA for ${path}.`);
    if (!['100644', '100755', '120000'].includes(mode)) throw new Error(`Unsupported git file mode for ${path}.`);
    const parts = path.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.has(part)) node.set(part, new Map());
      node = node.get(part);
      if (!(node instanceof Map)) throw new Error(`Path is both a file and a folder: ${path}`);
    }
    const name = parts.at(-1);
    if (node.has(name)) throw new Error(`Duplicate tree path: ${path}`);
    node.set(name, { sha: blob, mode });
  }
  return hashTree(root);
}

function globToRegex(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] === '*') {
        const before = i === 0 || glob[i - 1] === '/';
        const after = i + 2 === glob.length || glob[i + 2] === '/';
        if (before && after) {
          // Leading "**/", middle "/**/" and trailing "/**".
          if (i + 2 === glob.length) out += '.*';
          else { out += '(?:.*/)?'; i++; }
          i++;
          continue;
        }
      }
      out += '[^/]*';
    } else if (char === '?') out += '[^/]';
    else if (char === '[') {
      const end = glob.indexOf(']', i + 2);
      if (end === -1) { out += '\\['; continue; }
      let body = glob.slice(i + 1, end);
      if (body.startsWith('!')) body = `^${body.slice(1)}`;
      out += `[${body.replace(/\\/g, '\\\\')}]`;
      i = end;
    } else if (char === '\\' && i + 1 < glob.length) out += `\\${glob[++i]}`;
    else out += char.replace(/[.+^${}()|\]\\/]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

// Parse gitignore-format text. base is the folder holding the rules ('' for the
// project root and for .git/info/exclude).
export function parseIgnore(text, base = '') {
  const rules = [];
  for (const raw of String(text).split(/\r?\n/)) {
    let line = raw.replace(/(?<!\\)\s+$/, '');
    if (!line || line.startsWith('#')) continue;
    let negate = false;
    if (line.startsWith('!')) { negate = true; line = line.slice(1); }
    else if (line.startsWith('\\!') || line.startsWith('\\#')) line = line.slice(1);
    let dirOnly = false;
    if (line.endsWith('/')) { dirOnly = true; line = line.slice(0, -1); }
    if (!line) continue;
    const anchored = line.includes('/');
    if (line.startsWith('/')) line = line.slice(1);
    rules.push({ base, negate, dirOnly, anchored, regex: globToRegex(line) });
  }
  return rules;
}

// The last matching rule wins. Rules must be ordered from lowest precedence
// (.git/info/exclude) to highest (the deepest .gitignore). A path inside an
// ignored folder is never reached, because traversal skips that folder.
export function isIgnored(rules, path, isDirectory) {
  let ignored = false;
  for (const rule of rules) {
    if (rule.dirOnly && !isDirectory) continue;
    if (rule.base && !path.startsWith(`${rule.base}/`)) continue;
    const relative = rule.base ? path.slice(rule.base.length + 1) : path;
    const subject = rule.anchored ? relative : relative.split('/').at(-1);
    if (rule.regex.test(subject)) ignored = !rule.negate;
  }
  return ignored;
}
