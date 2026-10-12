// Serialized into the page. Use visible content as the active workspace proof;
// generated CSS class names are not a stable tab identity.
export function makeWorkspace(action) {
  const visible = element => {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const treesIn = root => [...root.querySelectorAll('[data-testid="virtualized-file-tree-container"][role="tree"]')].filter(visible);
  const radios = [...document.querySelectorAll('input[type="radio"][value="code"]')];
  if (radios.length) {
    if (radios.length !== 1) throw new Error('Expected exactly one Make Code tab.');
    if (action === 'ensure-preview') {
      const previews = [...document.querySelectorAll('input[type="radio"][value="preview"]')];
      if (previews.length !== 1) throw new Error('Make Preview tab is unavailable or ambiguous.');
      if (!previews[0].checked) previews[0].click();
      return { root: document, mode: 'legacy-code', ready: false };
    }
    if (action === 'ensure-code' && !radios[0].checked) radios[0].click();
    return { root: document, mode: 'legacy-code', ready: radios[0].checked && treesIn(document).length === 1 };
  }
  const candidates = [...document.querySelectorAll('[data-testid="figmake-workspace-container"]')];
  const roots = candidates.filter(visible);
  if (candidates.length === 1 && !roots.length) {
    throw new Error('Make workspace is hidden or has no layout. Select this project tab in Figma Desktop, show its workspace, and let the editor finish loading before retrying.');
  }
  if (roots.length !== 1) throw new Error('Make workspace is unavailable or ambiguous. Run make ui to inspect this layout.');
  const root = roots[0];
  const navigation = [...root.querySelectorAll('nav[aria-label="Editor views"]')].filter(visible);
  if (navigation.length !== 1) throw new Error('Make workspace navigation is unavailable or ambiguous.');
  const files = [...navigation[0].querySelectorAll('button[aria-label="Close Files tab"]')].filter(visible).map(close => {
    const buttons = [...close.parentElement.querySelectorAll(':scope > button')].filter(button => button !== close && visible(button));
    // The tab title changes from Files to the selected filename.
    if (buttons.length !== 1) throw new Error('Unsupported Make Files tab controls.');
    return buttons[0];
  });
  if (action === 'ensure-preview') {
    const browsers = [...navigation[0].querySelectorAll('button')].filter(button => visible(button) && !files.includes(button) && button.innerText?.trim() === 'Browser');
    if (browsers.length !== 1) throw new Error('Make Browser workspace tab is unavailable or ambiguous.');
    browsers[0].click();
    return { root, mode: 'files-workspace', ready: false };
  }
  if (!files.length) throw new Error('No Make Files workspace tab is open. Open Files in the workspace, then retry.');
  const headers = [...root.querySelectorAll('[data-testid="files-workspace-header"]')].filter(visible);
  if (headers.length > 1 || treesIn(root).length > 1) throw new Error('Multiple visible Make Files panes are ambiguous; select one workspace pane.');
  if (headers.length === 1 && !treesIn(root).length && action === 'ensure-code') {
    const show = [...headers[0].querySelectorAll('button[aria-label="Show files"][aria-expanded="false"]')].filter(visible);
    if (show.length === 1) show[0].click();
  }
  if (!treesIn(root).length && action === 'ensure-code') {
    if (headers.length === 1) return { root, mode: 'files-workspace', ready: false };
    if (files.length !== 1) throw new Error('Multiple Make Files tabs are open with none active. Select the intended Files tab, then retry.');
    files[0].click();
  }
  return { root, mode: 'files-workspace', ready: treesIn(root).length === 1 && [...root.querySelectorAll('[data-testid="files-workspace-header"]')].filter(visible).length === 1 };
}
