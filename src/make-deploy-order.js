import { posix } from 'node:path';

// Write order for `make deploy`: a file's local imports are written before the
// file, so Make's build never meets an importer without its module (RWS: a
// hung build and a dropped file channel when src/legacy/.../index.jsx landed
// before the src/mocks/recordedApi.ts it imports). Pure: it reads decoded text.
//
// Local imports are relative, root-absolute ("/src/x") and "@/x" (= src/x)
// specifiers, static, dynamic and require() forms, and import.meta.glob
// patterns. Package imports are ignored. A specifier resolves as Vite would:
// the exact path, then the default extensions, then an index file. Only
// planned files count; an edge to a file the deploy does not write is moot.

const EXTENSIONS = ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json'];
const IMPORT = /\b(?:import|export)\s*(?:[^'"`;]*?\bfrom\s*)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]([^'"]+)['"]/g;
const GLOB_CALL = /\bimport\.meta\.glob\s*\(\s*(\[[^\]]*\]|['"][^'"]+['"])/g;
const QUOTED = /['"]([^'"]+)['"]/g;

const isLocal = spec => spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/') || spec.startsWith('@/');
const target = (from, spec) => {
  const bare = spec.replace(/[?#].*$/, '');
  if (bare.startsWith('/')) return posix.normalize(bare.slice(1));
  if (bare.startsWith('@/')) return posix.normalize(`src/${bare.slice(2)}`);
  return posix.join(posix.dirname(from), bare);
};

function resolveSpec(from, spec, known) {
  if (!isLocal(spec)) return null;
  const base = target(from, spec);
  const candidates = [base];
  const swapped = /\.(m?js|jsx)$/.exec(base);
  if (swapped) candidates.push(base.slice(0, -swapped[0].length) + (swapped[1] === 'jsx' ? '.tsx' : swapped[1] === 'mjs' ? '.mts' : '.ts'));
  for (const extension of EXTENSIONS) candidates.push(base + extension);
  for (const extension of EXTENSIONS) candidates.push(`${base}/index${extension}`);
  return candidates.find(path => known.has(path)) ?? null;
}

const globRegExp = pattern => new RegExp(`^${pattern.replace(/[.+^$()|[\]\\]/g, '\\$&')
  .replace(/\*\*\/|\*\*|\*|\?|\{([^}]*)\}/g, (match, alternatives) => (match === '**/' ? '(?:.*/)?' : match === '**' ? '.*' : match === '*' ? '[^/]*'
    : match === '?' ? '[^/]' : `(?:${alternatives.split(',').join('|')})`))}$`);

function globTargets(from, patterns, known) {
  const include = patterns.filter(pattern => !pattern.startsWith('!')).map(pattern => globRegExp(target(from, pattern)));
  const exclude = patterns.filter(pattern => pattern.startsWith('!')).map(pattern => globRegExp(target(from, pattern.slice(1))));
  return [...known].filter(path => include.some(rule => rule.test(path)) && !exclude.some(rule => rule.test(path)));
}

export function localImports(from, text, known) {
  const found = new Set();
  for (const match of text.matchAll(IMPORT)) {
    const path = resolveSpec(from, match[1] ?? match[2] ?? match[3], known);
    if (path) found.add(path);
  }
  for (const call of text.matchAll(GLOB_CALL)) {
    const patterns = [...call[1].matchAll(QUOTED)].map(match => match[1]).filter(pattern => isLocal(pattern.replace(/^!/, '')));
    for (const path of globTargets(from, patterns, known)) found.add(path);
  }
  found.delete(from);
  return found;
}

// Strongly connected components (Tarjan), so a cycle is one unit.
function components(nodes, edges) {
  const index = new Map();
  const low = new Map();
  const stack = [];
  const on = new Set();
  const out = [];
  const visit = node => {
    index.set(node, index.size);
    low.set(node, index.get(node));
    stack.push(node);
    on.add(node);
    for (const next of edges.get(node)) {
      if (!index.has(next)) { visit(next); low.set(node, Math.min(low.get(node), low.get(next))); }
      else if (on.has(next)) low.set(node, Math.min(low.get(node), index.get(next)));
    }
    if (low.get(node) !== index.get(node)) return;
    const members = [];
    for (let member; member !== node;) { member = stack.pop(); on.delete(member); members.push(member); }
    out.push(members.sort());
  };
  for (const node of nodes) if (!index.has(node)) visit(node);
  return out;
}

// texts: Map(path -> decoded text) of the files to order. Imports first; the
// smaller path first among files that are ready together; the members of an
// import cycle in path order.
export function importOrder(texts) {
  const nodes = [...texts.keys()].sort();
  const known = new Set(nodes);
  const edges = new Map(nodes.map(path => [path, [...localImports(path, texts.get(path), known)].sort()]));
  const groups = components(nodes, edges);
  const groupOf = new Map(groups.flatMap((members, id) => members.map(path => [path, id])));
  const waiting = groups.map((members, id) => new Set(members.flatMap(path => edges.get(path)).map(path => groupOf.get(path)).filter(other => other !== id)));
  const importers = groups.map(() => []);
  waiting.forEach((needs, id) => needs.forEach(other => importers[other].push(id)));
  const ready = groups.map((_, id) => id).filter(id => !waiting[id].size);
  const order = [];
  while (ready.length) {
    ready.sort((a, b) => (groups[a][0] < groups[b][0] ? 1 : -1));
    const id = ready.pop();
    order.push(...groups[id]);
    for (const importer of importers[id]) {
      waiting[importer].delete(id);
      if (!waiting[importer].size) ready.push(importer);
    }
  }
  return order;
}
