/** Decode replacement bytes without silently removing a UTF-8 byte-order mark. */
export function decodeMakeSource(bytes) {
  if (bytes.length > 2 * 1024 * 1024) throw new Error('Make source replacement is limited to 2 MiB');
  const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  if (content.includes('\0')) throw new Error('Make replacement must be a text source file');
  return content;
}
