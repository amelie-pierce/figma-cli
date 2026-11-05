import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { deployDir, readReceipt } from './make-deploy.js';

// A receipt-only view. No Make client, git, or GitHub operation is involved.
export function deployStatus({ receiptPath, fileKey, home } = {}) {
  if (receiptPath && fileKey) throw new Error('Choose --receipt or --file.');
  if (!receiptPath && !fileKey) throw new Error('Deploy status requires --receipt <path> or --file <key>.');
  const dir = deployDir(home);
  const paths = receiptPath ? [receiptPath] : existsSync(dir)
    ? readdirSync(dir).filter(name => name.endsWith('.json')).map(name => join(dir, name)) : [];
  const receipts = paths.map(path => {
    try { return readReceipt(path); }
    catch (error) { if (receiptPath) throw error; return null; }
  }).filter(receipt => receipt && (!fileKey || receipt.fileKey === fileKey));
  receipts.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const receipt = receipts[0];
  if (!receipt) throw new Error(fileKey ? `No local deploy receipt for ${fileKey}.` : 'No local deploy receipts found.');
  const completed = new Set((receipt.completedWrites || []).filter(write => !write.uncertain && !write.backupOnly).map(write => write.path)).size;
  const total = receipt.plan.files.length;
  const startedMs = Date.parse(receipt.at);
  const lastWriteAt = receipt.lastWriteAt || null;
  const lastMs = Date.parse(lastWriteAt);
  const segmentMs = receipt.writeRun ? Date.parse(receipt.writeRun.startedAt) : startedMs;
  const segmentWrites = receipt.writeRun ? receipt.writeRun.completedWrites : completed;
  const averageSecondsPerFile = segmentWrites && Number.isFinite(lastMs) && Number.isFinite(segmentMs) && lastMs >= segmentMs
    ? Math.round((lastMs - segmentMs) / segmentWrites / 1000) : null;
  const remaining = Math.max(0, total - completed);
  const eta = receipt.stage === 'writing' && receipt.outcome === 'uncertain' && remaining && averageSecondsPerFile != null
    ? new Date(lastMs + remaining * averageSecondsPerFile * 1000).toISOString() : null;
  return { receiptPath: receipt.receiptPath, deployId: receipt.deployId, fileKey: receipt.fileKey,
    completedWrites: completed, totalWrites: total, stage: receipt.stage, outcome: receipt.outcome,
    startedAt: receipt.at, lastWriteAt, averageSecondsPerFile, eta };
}

export function formatDeployStatus(status) {
  return `deploy: ${status.completedWrites}/${status.totalWrites} ${status.stage} (${status.outcome})\n` +
    `started: ${status.startedAt}\nlast write: ${status.lastWriteAt || 'none'}\n` +
    `average: ${status.averageSecondsPerFile == null ? 'unknown' : `${status.averageSecondsPerFile}s/file`}\n` +
    `expected finish: ${status.eta || 'unknown'}\nreceipt: ${status.receiptPath}`;
}
