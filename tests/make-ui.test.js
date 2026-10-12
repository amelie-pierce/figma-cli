import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { makeUiSnapshot } from '../src/make-ui.js';

function element(tag, text = '', children = [], blocked = false) {
  return {
    tagName: tag, children, parentElement: null,
    getBoundingClientRect: () => ({ width: 100, height: 20 }),
    getAttribute: name => name === 'aria-label' ? 'UI control' : null,
    matches: () => blocked,
    get childNodes() {
      if (blocked) throw new Error('Must not read source or input content');
      return [{ nodeType: 3, textContent: text }];
    },
    get value() { throw new Error('Must not read input values'); },
    click() { throw new Error('Diagnostics must not select controls'); },
  };
}

test('UI diagnostics omit editor/input contents, preserve UI labels and bound lists', () => {
  const root = element('NAV', '', [element('SPAN', 'Files'), element('DIV', 'private source', [], true),
    element('INPUT', 'private input', [], true)]);
  const document = {
    visibilityState: 'visible',
    querySelector: () => root,
    querySelectorAll: () => Array(70).fill(root),
    get body() { throw new Error('Diagnostics must not inspect page content'); },
  };
  const result = vm.runInNewContext(`(${makeUiSnapshot.toString()})()`, {
    innerWidth: 0, innerHeight: 0,
    document, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
  });
  const serialized = JSON.stringify(result);
  assert.match(serialized, /Files/);
  assert.equal(result.editorViews.layout.width, 100);
  assert.equal(result.editorViews.layout.height, 20);
  assert.equal(result.viewport.width, 0);
  assert.equal(result.viewport.height, 0);
  assert.equal(result.viewport.visibility, 'visible');
  assert.doesNotMatch(serialized, /private source|private input/);
  assert.ok(result.groups.every(group => group.nodes.length === 50));
});

test('UI diagnostics remain available when no known workspace controls exist', () => {
  const result = vm.runInNewContext(`(${makeUiSnapshot.toString()})()`, {
    document: { querySelector: () => null, querySelectorAll: () => [] },
  });
  assert.equal(result.editorViews, null);
  assert.equal(result.filesHeader, null);
  assert.equal(result.viewport.width, null);
  assert.equal(result.viewport.height, null);
  assert.ok(result.groups.every(group => group.nodes.length === 0));
});
