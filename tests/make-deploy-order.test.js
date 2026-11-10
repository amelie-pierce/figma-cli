import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { importOrder, localImports } from '../src/make-deploy-order.js';

const order = files => importOrder(new Map(Object.entries(files)));

describe('make deploy import order (pure)', () => {
  it('writes a relative import before its importer, with path order as the tie-break', () => {
    assert.deepEqual(order({
      'src/a.ts': 'import { z } from "./z";\nexport const a = z;',
      'src/b.ts': 'export const b = 1;',
      'src/z.ts': 'export const z = 1;',
    }), ['src/b.ts', 'src/z.ts', 'src/a.ts']);
  });

  it('follows the RWS shape: an importer in a deep folder waits for src/mocks/recordedApi.ts', () => {
    assert.deepEqual(order({
      'src/legacy/src/utils/apis/index.jsx': 'import { recorded } from "../../../../mocks/recordedApi";\nexport default recorded;',
      'src/mocks/recordedApi.ts': 'export const recorded = {};',
    }), ['src/mocks/recordedApi.ts', 'src/legacy/src/utils/apis/index.jsx']);
  });

  it('sees dynamic imports, re-exports, side-effect imports, require and the @/ alias', () => {
    const files = {
      'src/a.ts': 'const load = () => import("./lazy");\nexport * from "./reexport";\nimport "./side.css";\nconst x = require("./cjs");\nimport q from "@/shared/q";',
      'src/cjs.js': '', 'src/lazy.ts': '', 'src/reexport.ts': '', 'src/side.css': '', 'src/shared/q.ts': '',
    };
    assert.deepEqual([...localImports('src/a.ts', files['src/a.ts'], new Set(Object.keys(files)))].sort(),
      ['src/cjs.js', 'src/lazy.ts', 'src/reexport.ts', 'src/shared/q.ts', 'src/side.css']);
    assert.equal(order(files).at(-1), 'src/a.ts');
  });

  it('expands import.meta.glob patterns, with a negative pattern', () => {
    const files = {
      'src/app.ts': 'const pages = import.meta.glob(["./pages/*.tsx", "!./pages/skip.tsx"], { eager: true });',
      'src/pages/home.tsx': '', 'src/pages/skip.tsx': 'import "../zzz";', 'src/zzz.ts': '',
      'src/pages/deep/x.tsx': '',
    };
    assert.deepEqual([...localImports('src/app.ts', files['src/app.ts'], new Set(Object.keys(files)))], ['src/pages/home.tsx']);
    const one = { 'src/main.ts': 'import.meta.glob("/src/mocks/**/*.ts")', 'src/mocks/a/b.ts': '', 'src/mocks/c.ts': '' };
    assert.deepEqual(order(one), ['src/mocks/a/b.ts', 'src/mocks/c.ts', 'src/main.ts']);
  });

  it('resolves index files and the .js-to-.ts specifier, and ignores packages', () => {
    const files = {
      'src/a.ts': 'import b from "./b";\nimport c from "./c.js";\nimport react from "react";\nimport scoped from "@scope/pkg";',
      'src/b/index.tsx': '', 'src/c.ts': '',
    };
    assert.deepEqual([...localImports('src/a.ts', files['src/a.ts'], new Set(Object.keys(files)))].sort(), ['src/b/index.tsx', 'src/c.ts']);
  });

  it('falls back to path order inside an import cycle and keeps its importers after it', () => {
    assert.deepEqual(order({
      'src/m.ts': 'import "./b";',
      'src/a.ts': 'import "./b";',
      'src/b.ts': 'import "./a";',
      'src/c.ts': '',
      'src/z.ts': 'import "./m";',
    }), ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/m.ts', 'src/z.ts']);
  });

  it('is path order when nothing imports anything, and never loses a file', () => {
    const files = { 'z.ts': '', 'a.ts': '', 'm/x.ts': '' };
    assert.deepEqual(order(files), ['a.ts', 'm/x.ts', 'z.ts']);
    assert.equal(order({ 'a.ts': 'import "./a";' }).length, 1);
  });
});
