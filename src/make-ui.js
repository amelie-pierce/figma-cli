// Bounded structural diagnostics. Never inspect editor source, input values, or private stores.
export function makeUiSnapshot() {
  const describe = element => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return { tag: element.tagName, visible: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden',
      layout: { width: rect.width, height: rect.height, display: style.display, visibility: style.visibility },
      attributes: Object.fromEntries(['role', 'aria-label', 'aria-selected', 'aria-expanded', 'aria-current', 'data-testid', 'data-state', 'data-active', 'tabindex', 'style', 'class', 'type'].map(name => [name, element.getAttribute(name)?.slice(0, 500)]).filter(([, value]) => value != null)),
      checked: element.type === 'radio' ? element.checked : undefined };
  };
  const selectors = ['[role="tab"]', 'input[type="radio"]', '[data-testid*="workspace"]', '[data-testid*="breadcrumb"]', 'button[aria-label*="Close"]', '[role="tree"]'];
  let budget = 250;
  const structure = (element, depth = 0) => {
    if (!element || budget-- <= 0 || depth > 9) return null;
    const result = describe(element);
    if (element.matches('.cm-editor, .cm-content, iframe, input, textarea, [contenteditable="true"]')) return result;
    result.text = [...element.childNodes].filter(node => node.nodeType === 3).map(node => node.textContent).join('').trim().slice(0, 120);
    result.children = [...element.children].map(child => structure(child, depth + 1)).filter(Boolean);
    return result;
  };
  return { editorViews: structure(document.querySelector('nav[aria-label="Editor views"]')), filesHeader: structure(document.querySelector('[data-testid="files-workspace-header"]')), groups: selectors.map(selector => ({ selector, nodes: [...document.querySelectorAll(selector)].slice(0, 50).map(element => ({ ...describe(element),
    children: [...element.children].slice(0, 12).map(describe),
    parent: element.parentElement ? describe(element.parentElement) : null })) })) };
}
