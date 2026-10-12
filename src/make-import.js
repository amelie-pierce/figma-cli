import { createHash } from 'node:crypto';
import { decodeMakeSource } from './make-source.js';

export function validateImportFiles(files, existing = []) {
  if (!Array.isArray(files) || !files.length || files.length > 300) {
    throw new Error('Make import requires 1–300 source files.');
  }
  const paths = new Set();
  let total = 0;
  const result = files.map(file => {
    const path = file?.path;
    if (typeof path !== 'string' || path.length > 512 ||
        path.split('/').some(part => !part || part === '.' || part === '..' || part.trim() !== part) ||
        /[\\:\u0000-\u001f\u007f]/.test(path)) {
      throw new Error('Make import requires unambiguous project-relative paths.');
    }
    if (typeof file.content !== 'string') throw new Error(`Missing UTF-8 source content: ${path}`);
    const bytes = Buffer.from(file.content, 'utf8');
    if (decodeMakeSource(bytes) !== file.content) throw new Error(`Invalid Unicode source: ${path}`);
    total += bytes.length;
    if (total > 20 * 1024 * 1024) throw new Error('Make import is limited to 20 MiB total.');
    const key = path.toLowerCase();
    if (paths.has(key)) throw new Error(`Duplicate or case-ambiguous import path: ${path}`);
    paths.add(key);
    return { path, content: file.content, bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  for (const file of result) {
    const key = file.path.toLowerCase();
    for (const entry of [...existing, ...result.filter(other => other !== file).map(other => ({ ...other, kind: 'file' }))]) {
      const candidate = entry.path.toLowerCase();
      if (key === candidate || (entry.kind === 'file' && key.startsWith(`${candidate}/`)) || candidate.startsWith(`${key}/`)) {
        throw new Error(`Make import would replace or conflict with an existing path: ${file.path}`);
      }
    }
  }
  return result;
}
