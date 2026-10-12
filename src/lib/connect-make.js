import { getCdpSettings } from './cdp-config.js';
import { probeCdp, waitForCdp, patchFailure } from './cdp-diagnostics.js';
import { locateDesktop, launchDesktop, stopDesktop } from './desktop-runtime.js';
import { isPatched, patchFigma } from '../figma-patch.js';

// A Make-only setup path: no Design daemon, curl, shell, or UI automation.
// Dependency injection keeps restart/patch coverage entirely offline.
export async function connectMakeDesktop({ port, platform = process.platform,
  locate = locateDesktop, probe = probeCdp, wait = waitForCdp,
  patched = isPatched, patch = patchFigma, stop = stopDesktop, launch = launchDesktop } = {}) {
  const settings = getCdpSettings({ port });
  const before = await probe({ port: settings.port });
  if (before.reachable) {
    return { ...before, reused: true, ready: before.figmaTarget,
      note: before.figmaTarget
        ? 'Reused the existing Figma endpoint without patching or restarting. Open the intended Make project, then run make list and make inspect.'
        : 'The port already exposes CDP but no Figma target. Confirm the port; no application was patched, restarted, or stopped.' };
  }
  const installation = locate();
  if (!installation) {
    return { ready: false, ...settings, code: 'FIGMA_NOT_FOUND',
      error: 'Figma Desktop installation not found. Set FIGMA_APP_PATH to its installation folder (.app on macOS) if it is installed in a custom location.' };
  }
  try {
    if (patched() === false) patch();
  } catch (error) {
    return { ready: false, ...settings, ...patchFailure(error, platform) };
  }
  try {
    stop();
    await new Promise(resolve => setTimeout(resolve, 500));
    await launch(installation.binary, settings.port);
  } catch (error) {
    return { ready: false, ...settings, code: 'FIGMA_RESTART_FAILED', error: error.message,
      recovery: 'The OS helper could not stop or launch Figma. Check allowed process execution and app permissions. No shell or computer-use fallback was attempted.' };
  }
  const after = await wait({ port: settings.port });
  return { ...after, ready: Boolean(after.reachable && after.figmaTarget), reused: false,
    next: 'Open the intended Make project and run connection, make list, then make inspect --file KEY. Endpoint discovery alone does not verify editor readiness.' };
}
