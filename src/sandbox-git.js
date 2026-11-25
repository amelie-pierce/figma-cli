import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { READ_CONCURRENCY, mapLimit } from './lib/map-limit.js';

// Read-only git object access for Make's sandbox repository. Make mixes file
// modes (100755 and 100644) that its listing does not expose, so the saved
// tree SHA is read from the version's own commit, not re-hashed from bytes.
// I/O is injected: readFile(path) returns bytes or null when absent, and
// listDir(path) returns entry names or null; paths are relative to `.git`.

const SHA = /^[a-f0-9]{40}$/;
const TYPES = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const MAX_PACK_BYTES = 64 * 1024 * 1024;

function verified(sha, type, content) {
  const actual = createHash('sha1').update(`${type} ${content.length}\0`).update(content).digest('hex');
  if (actual !== sha) throw new Error(`Make sandbox git object ${sha} failed its hash check.`);
  return { type, content };
}

function applyDelta(base, delta) {
  let pos = 0;
  const varint = () => {
    let value = 0, shift = 0, byte;
    do { byte = delta[pos++]; value += (byte & 0x7f) * 2 ** shift; shift += 7; } while (byte & 0x80);
    return value;
  };
  if (varint() !== base.length) throw new Error('Make sandbox git delta base size mismatch.');
  const out = Buffer.alloc(varint());
  let at = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if (op & 0x80) {
      let offset = 0, size = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) offset += delta[pos++] * 2 ** (8 * i);
      for (let i = 0; i < 3; i++) if (op & (0x10 << i)) size += delta[pos++] * 2 ** (8 * i);
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('Make sandbox git delta copy is out of range.');
      at += base.copy(out, at, offset, offset + size);
    } else if (op) {
      at += delta.copy(out, at, pos, pos + op);
      pos += op;
    } else throw new Error('Make sandbox git delta has a reserved opcode.');
  }
  if (at !== out.length) throw new Error('Make sandbox git delta result size mismatch.');
  return out;
}

function idxOffset(idx, sha) {
  if (idx.readUInt32BE(0) !== 0xff744f63 || idx.readUInt32BE(4) !== 2) throw new Error('Unsupported Make sandbox pack index.');
  const first = parseInt(sha.slice(0, 2), 16);
  const count = idx.readUInt32BE(8 + 255 * 4);
  let lo = first ? idx.readUInt32BE(8 + (first - 1) * 4) : 0;
  let hi = idx.readUInt32BE(8 + first * 4);
  const target = Buffer.from(sha, 'hex');
  const names = 8 + 256 * 4;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const cmp = Buffer.compare(idx.subarray(names + mid * 20, names + mid * 20 + 20), target);
    if (cmp === 0) {
      const offsets = names + count * 24;
      const small = idx.readUInt32BE(offsets + mid * 4);
      if (!(small & 0x80000000)) return small;
      const large = offsets + count * 4 + (small & 0x7fffffff) * 8;
      return Number(idx.readBigUInt64BE(large));
    }
    if (cmp < 0) lo = mid + 1; else hi = mid;
  }
  return null;
}

function treeEntries(content) {
  const entries = [];
  let pos = 0;
  while (pos < content.length) {
    const space = content.indexOf(0x20, pos);
    const nul = content.indexOf(0, space);
    entries.push({ mode: content.subarray(pos, space).toString('latin1'), name: content.subarray(space + 1, nul).toString('utf8'),
      sha: content.subarray(nul + 1, nul + 21).toString('hex') });
    pos = nul + 21;
  }
  return entries;
}

export class SandboxGit {
  constructor({ readFile, listDir }) {
    this.readFile = readFile;
    this.listDir = listDir;
    this.cache = new Map();
    this.packs = null;
  }

  // Memoised as promises so concurrent object() calls share one load.
  _packs() {
    this.packs ||= (async () => {
      const names = (await this.listDir('objects/pack')) || [];
      const packs = [];
      for (const name of names.filter(n => /^pack-[a-f0-9]{40}\.idx$/.test(n)).sort()) {
        const idx = await this.readFile(`objects/pack/${name}`);
        if (!idx) throw new Error(`Make sandbox pack index is unreadable: ${name}`);
        packs.push({ idx, name: name.replace(/\.idx$/, '.pack'), pack: null });
      }
      return packs;
    })().catch(error => { this.packs = null; throw error; });
    return this.packs;
  }

  async _packObject(entry, offset) {
    entry.loading ||= (async () => {
      const pack = await this.readFile(`objects/pack/${entry.name}`);
      if (!pack || pack.length > MAX_PACK_BYTES) throw new Error(`Make sandbox pack is unreadable or too large: ${entry.name}`);
      entry.pack = pack;
    })().catch(error => { entry.loading = null; throw error; });
    if (!entry.pack) await entry.loading;
    const pack = entry.pack;
    let pos = offset;
    let byte = pack[pos++];
    const type = (byte >> 4) & 7;
    while (byte & 0x80) byte = pack[pos++];
    if (type === 6) {
      byte = pack[pos++];
      let distance = byte & 0x7f;
      while (byte & 0x80) { byte = pack[pos++]; distance = (distance + 1) * 128 + (byte & 0x7f); }
      const base = await this._packObject(entry, offset - distance);
      return { type: base.type, content: applyDelta(base.content, inflateSync(pack.subarray(pos))) };
    }
    if (type === 7) {
      const base = await this.object(pack.subarray(pos, pos + 20).toString('hex'));
      return { type: base.type, content: applyDelta(base.content, inflateSync(pack.subarray(pos + 20))) };
    }
    if (!TYPES[type]) throw new Error('Unsupported Make sandbox pack object type.');
    return { type: TYPES[type], content: inflateSync(pack.subarray(pos)) };
  }

  async object(sha) {
    if (!SHA.test(sha || '')) throw new Error('Invalid git object SHA.');
    if (this.cache.has(sha)) return this.cache.get(sha);
    let result;
    const loose = (await this.listDir(`objects/${sha.slice(0, 2)}`))?.includes(sha.slice(2))
      ? await this.readFile(`objects/${sha.slice(0, 2)}/${sha.slice(2)}`) : null;
    if (loose) {
      const raw = inflateSync(loose);
      const nul = raw.indexOf(0);
      const [type, size] = raw.subarray(0, nul).toString('latin1').split(' ');
      const content = raw.subarray(nul + 1);
      if (Number(size) !== content.length) throw new Error(`Make sandbox git object ${sha} has a bad size.`);
      result = verified(sha, type, content);
    } else {
      for (const entry of await this._packs()) {
        const offset = idxOffset(entry.idx, sha);
        if (offset == null) continue;
        const { type, content } = await this._packObject(entry, offset);
        result = verified(sha, type, content);
        break;
      }
    }
    if (!result) throw new Error(`Make sandbox git object ${sha} is missing.`);
    this.cache.set(sha, result);
    return result;
  }

  async commitTree(sha) {
    const { type, content } = await this.object(sha);
    if (type !== 'commit') throw new Error(`Make sandbox object ${sha} is not a commit.`);
    const tree = /^tree ([a-f0-9]{40})\n/.exec(content.toString('utf8'))?.[1];
    if (!tree) throw new Error(`Make sandbox commit ${sha} has no tree.`);
    return tree;
  }

  // Flatten a tree into path → { mode, blob }, recursing into subtrees. The
  // trees are fetched a level at a time with bounded concurrency first; the
  // walk below then runs in order from the object cache, so the Map order and
  // the first error are those of a sequential walk.
  async flatten(treeSha, prefix = '', out = new Map()) {
    let level = [treeSha];
    const seen = new Set(level);
    while (level.length) {
      const trees = await mapLimit(level, READ_CONCURRENCY, sha => this.object(sha).catch(() => null));
      level = [];
      for (const tree of trees) {
        if (tree?.type !== 'tree') continue;
        for (const entry of treeEntries(tree.content)) {
          if (entry.mode === '40000' && !seen.has(entry.sha)) { seen.add(entry.sha); level.push(entry.sha); }
        }
      }
    }
    return this._flatten(treeSha, prefix, out);
  }

  async _flatten(treeSha, prefix, out) {
    const { type, content } = await this.object(treeSha);
    if (type !== 'tree') throw new Error(`Make sandbox object ${treeSha} is not a tree.`);
    for (const { mode, name, sha } of treeEntries(content)) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (mode === '40000') await this._flatten(sha, path, out);
      else out.set(path, { mode: mode.padStart(6, '0'), blob: sha });
    }
    return out;
  }

  // Whether ancestor is head itself or reachable through its parents. A missing
  // object fails closed through object().
  async reaches(head, ancestor, limit = 5000) {
    const queue = [head];
    const seen = new Set();
    while (queue.length) {
      const sha = queue.shift();
      if (sha === ancestor) return true;
      if (seen.has(sha)) continue;
      seen.add(sha);
      if (seen.size > limit) throw new Error('Make sandbox history exceeds the ancestry limit.');
      const { type, content } = await this.object(sha);
      if (type !== 'commit') throw new Error(`Make sandbox object ${sha} is not a commit.`);
      const header = content.toString('utf8').split('\n\n')[0];
      for (const match of header.matchAll(/^parent ([a-f0-9]{40})$/gm)) queue.push(match[1]);
    }
    return false;
  }

  // HEAD's commit SHA, through a loose ref or packed-refs.
  async head() {
    const head = (await this.readFile('HEAD'))?.toString('utf8').trim();
    if (!head) throw new Error('Make sandbox HEAD is unreadable.');
    if (SHA.test(head)) return head;
    const ref = /^ref: (refs\/[A-Za-z0-9._/-]+)$/.exec(head)?.[1];
    if (!ref || ref.split('/').some(part => !part || part === '..')) throw new Error('Make sandbox HEAD is not a branch ref.');
    const [folder, name] = [ref.slice(0, ref.lastIndexOf('/')), ref.slice(ref.lastIndexOf('/') + 1)];
    const loose = (await this.listDir(folder))?.includes(name) ? (await this.readFile(ref))?.toString('utf8').trim() : null;
    if (SHA.test(loose || '')) return loose;
    const packed = (await this.readFile('packed-refs'))?.toString('utf8') || '';
    const line = packed.split('\n').find(entry => entry.endsWith(` ${ref}`));
    const sha = line?.slice(0, 40);
    if (!SHA.test(sha || '')) throw new Error(`Make sandbox ref ${ref} is unresolved.`);
    return sha;
  }
}
