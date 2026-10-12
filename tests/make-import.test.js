import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateImportFiles } from '../src/make-import.js';

test('accepts nested React source, preserves Unicode and line endings', () => {
  const content = '\ufeffexport const Button = () => <button>你好</button>;\r\n';
  const [file] = validateImportFiles([{ path: 'src/ui/Button.tsx', content }], [{ path: 'src', kind: 'folder' }]);
  assert.equal(file.content, content);
  assert.equal(file.bytes, Buffer.byteLength(content));
  assert.match(file.sha256, /^[a-f0-9]{64}$/);
});

test('rejects traversal, ambiguous names, duplicates, malformed and oversized sources', () => {
  for (const path of ['', '/a', 'a/', '../a', 'a/../b', 'a//b', 'a\\b', 'a\0b', 'C:/a', ' a']) {
    assert.throws(() => validateImportFiles([{ path, content: '' }]), /paths/);
  }
  assert.throws(() => validateImportFiles([{ path: 'A', content: '' }, { path: 'a', content: '' }]), /Duplicate/);
  assert.throws(() => validateImportFiles([{ path: 'a', content: '\ud800' }]), /Unicode/);
  assert.throws(() => validateImportFiles([{ path: 'a', content: '\0' }]), /text source/);
  assert.throws(() => validateImportFiles([{ path: 'a', content: 'a'.repeat(2 * 1024 * 1024 + 1) }]), /2 MiB/);
  assert.throws(() => validateImportFiles([]), /1–300/);
});

test('never permits overwriting a file, folder, ancestor or another import', () => {
  const file = { path: 'src/ui', content: '' };
  for (const existing of [
    [{ path: 'src/ui', kind: 'file' }], [{ path: 'SRC/UI', kind: 'folder' }],
    [{ path: 'src', kind: 'file' }], [{ path: 'src/ui/Button.tsx', kind: 'file' }],
  ]) assert.throws(() => validateImportFiles([file], existing), /conflict/);
  assert.throws(() => validateImportFiles([file, { path: 'src/ui/Button.tsx', content: '' }]), /conflict/);
});
