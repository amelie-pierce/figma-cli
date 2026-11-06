import { parentPort, workerData } from 'node:worker_threads';
import { renewDeployLock } from './make-deploy-lock.js';

const { owner, health } = workerData;
function renew() {
  try { renewDeployLock(owner); return true; }
  catch (error) {
    Atomics.store(health, 0, 1);
    parentPort.postMessage({ error: error.message });
    return false;
  }
}
if (renew()) {
  parentPort.postMessage('ready');
  const timer = setInterval(() => { if (!renew()) clearInterval(timer); }, owner.leaseMs / 4);
}
