import { getCdpSettings, parseCdpPort } from './cdp-config.js';

export function cdpFailure(error, port) {
  const endpoint = `http://127.0.0.1:${port}/json`;
  const reason = error.cause?.code || error.code || error.name;
  const recovery = [
    'Confirm the port used to launch Figma Desktop; use --port PORT for one command or connection --save-port PORT to persist it.',
    'Opening Figma normally does not enable remote debugging. For Make, connect --make --port PORT uses direct OS helpers to patch/restart Desktop when needed; use existing restart authorization or obtain it first.',
    'An unreachable endpoint alone cannot distinguish a wrong port from disabled debugging. App Management is relevant only if patching fails with a permission error on macOS.',
    'Do not stop another service to free this port or fall back to computer-use tools.',
  ];
  return Object.assign(new Error(`Figma CDP discovery failed at ${endpoint}: ${error.message} (${reason}). Check the configured port and whether Desktop was launched with remote debugging.`, { cause: error }), {
    code: 'CDP_DISCOVERY_FAILED', endpoint, port, reason, recovery,
  });
}

export async function fetchCdpTargets(port, { signal = AbortSignal.timeout(5000) } = {}) {
  port = parseCdpPort(port);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json`, { signal, redirect: 'error' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const targets = await response.json();
    if (!Array.isArray(targets)) throw new Error('invalid CDP target list');
    return targets;
  } catch (error) { throw cdpFailure(error, port); }
}

export function figmaTargetKind(target) {
  if (target?.type !== 'page') return null;
  try {
    const url = new URL(target.url);
    if (url.protocol !== 'https:' || !['www.figma.com', 'figma.com'].includes(url.hostname) || url.username || url.password || url.port) return null;
    return url.pathname.match(/^\/(make|design|file)\//)?.[1] || 'figma';
  } catch { return null; }
}

export async function probeCdp(options = {}) {
  const settings = getCdpSettings(options);
  const endpoint = `http://127.0.0.1:${settings.port}/json`;
  try {
    const targets = await fetchCdpTargets(settings.port, { signal: AbortSignal.timeout(options.timeoutMs ?? 3000) });
    const kinds = targets.map(figmaTargetKind).filter(Boolean);
    return { ...settings, endpoint, reachable: true, figmaTarget: kinds.length > 0,
      makeTargets: kinds.filter(x => x === 'make').length,
      designTargets: kinds.filter(x => x === 'design' || x === 'file').length,
      status: kinds.length ? 'figma-target-found' : 'no-figma-target',
      note: kinds.length
        ? 'CDP discovery passed. This does not prove editor readiness or that the endpoint belongs to Desktop rather than a browser.'
        : 'CDP responds, but no Figma page is exposed. This may be another browser/service, or Desktop has no loaded Figma tab. Confirm the port before restarting anything.' };
  } catch (error) {
    return { ...settings, endpoint, reachable: false, status: 'endpoint-unavailable', error: error.message,
      reason: error.reason, recovery: error.recovery };
  }
}

export async function waitForCdp({ port, timeoutMs = 10000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let result;
  do {
    result = await probeCdp({ port, timeoutMs: Math.max(1, Math.min(1000, deadline - Date.now())) });
    if (result.reachable) return result;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, remaining)));
  } while (Date.now() < deadline);
  return result;
}

export function patchFailure(error, platform = process.platform) {
  const permission = ['EACCES', 'EPERM'].includes(error.code || error.cause?.code) || /permission|no write access|operation not permitted/i.test(error.message);
  return { error: error.message, code: permission ? 'PATCH_PERMISSION_DENIED' : 'PATCH_FAILED',
    recovery: permission && platform === 'darwin'
      ? 'macOS denied modification of Figma. Check System Settings → Privacy & Security → App Management for the app hosting your agent/Node process, then restart that host and retry. Full Disk Access alone is insufficient. Managed devices may require administrator assistance.'
      : permission ? 'The operating system denied modification of Figma. Ask your administrator for the required app permissions.'
        : 'Patching failed for a reason other than a confirmed permission denial. Review the original error; do not assume App Management is the cause.' };
}
