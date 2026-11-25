import { TREE_HIDDEN_ROOT_FILES } from './make-durable.js';

// One batched durable operation holds at most this many files and bytes, so it
// stays well inside the 120 s operation limit (about 0.7 s per file measured).
export const MAX_BATCH_FILES = 25;
export const MAX_BATCH_BYTES = 8 * 1024 * 1024;

// Make's install reacts to these, so each is written alone and settled on its own.
export const DEPENDENCY_FILES = Object.freeze([...TREE_HIDDEN_ROOT_FILES, 'package.json']);

// Never inside a batch: dependency files, and VENDOR.json, which vouches for
// the files written before it and is written last, after they are confirmed.
export const batchBarred = path => DEPENDENCY_FILES.includes(path) || path.split('/').pop() === 'VENDOR.json';

// Consecutive items in order, cut at MAX_BATCH_FILES files or MAX_BATCH_BYTES
// bytes. One file larger than the byte limit forms a chunk of its own.
export function chunkBatch(items, sizeOf = item => Buffer.byteLength(item.content ?? '')) {
  const chunks = [];
  let bytes = 0;
  for (const item of items) {
    const size = sizeOf(item) || 0;
    const last = chunks[chunks.length - 1];
    if (!last || last.length >= MAX_BATCH_FILES || bytes + size > MAX_BATCH_BYTES) { chunks.push([item]); bytes = size; }
    else { last.push(item); bytes += size; }
  }
  return chunks;
}

// Run `items` strictly in order. Each maximal run of consecutive batchable
// items goes through `batch(chunk)`, chunk by chunk; any other item goes through
// `single(item)` at its own position, so import order and "last" writes are kept.
export async function writeInOrder(items, { batchable, batch, single, sizeOf }) {
  let run = [];
  const flush = async () => {
    const chunks = chunkBatch(run, sizeOf);
    run = [];
    for (const chunk of chunks) await batch(chunk);
  };
  for (const item of items) {
    if (batchable(item)) { run.push(item); continue; }
    await flush();
    await single(item);
  }
  await flush();
}
