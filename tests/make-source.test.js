import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeMakeSource } from '../src/make-source.js';

test('replacement decoding preserves UTF-8 bytes, including BOM and line endings', () => {
  for (const value of ['', '\ufeffexport const label = "Tiếng Việt 🎨";\r\n', 'line one\nline two\r\n']) {
    const bytes = Buffer.from(value, 'utf8');
    assert.deepEqual(Buffer.from(decodeMakeSource(bytes), 'utf8'), bytes);
  }
});

test('replacement decoding rejects malformed UTF-8, binary NULs, and oversized source', () => {
  assert.throws(() => decodeMakeSource(Buffer.from([0xc3, 0x28])), /encoded data/i);
  assert.throws(() => decodeMakeSource(Buffer.from('text\0binary')), /text source file/);
  assert.throws(() => decodeMakeSource(Buffer.alloc(2 * 1024 * 1024 + 1, 65)), /2 MiB/);
});
