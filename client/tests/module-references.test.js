/**
 * Regression guard for client module imports & undeclared references
 * (prevents runtime `ReferenceError` crashes such as missing `API_BASE` imports).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { API_BASE } from '../src/api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, '..', 'src');
const API_FILE = path.join(SRC_DIR, 'api.js');

function walkSourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkSourceFiles(full, out);
    else if (/\.(js|jsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test('API_BASE defaults safely to an empty string when VITE_API_URL is unset', () => {
  assert.equal(API_BASE, '');
});

test('every client module referencing API_BASE imports it from api.js', () => {
  for (const file of walkSourceFiles(SRC_DIR)) {
    if (file === API_FILE) continue;
    const src = fs.readFileSync(file, 'utf8');
    if (/\bAPI_BASE\b/.test(src)) {
      const rel = path.relative(SRC_DIR, file);
      assert.match(
        src,
        /import\s*\{[^}]*\bAPI_BASE\b[^}]*\}\s*from\s*['"][^'"]*api(?:\.js)?['"]/,
        `${rel} uses API_BASE without importing it from api.js`
      );
    }
  }
});

test('no client source module contains undeclared identifiers or JSX components', (t) => {
  const req = createRequire(import.meta.url);
  let parser;
  let traverse;
  try {
    parser = req('@babel/parser');
    const mod = req('@babel/traverse');
    traverse = mod.default || mod;
  } catch {
    t.skip('@babel/parser not installed in this environment');
    return;
  }

  const BROWSER_GLOBALS = new Set([
    ...Object.getOwnPropertyNames(globalThis),
    'window', 'document', 'navigator', 'location', 'history', 'localStorage', 'sessionStorage',
    'CustomEvent', 'Event', 'FormData', 'File', 'Blob', 'URL', 'URLSearchParams', 'Headers',
    'Request', 'Response', 'AbortController', 'fetch', 'alert', 'confirm', 'prompt',
    'requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver', 'IntersectionObserver',
    'MutationObserver', 'HTMLElement', 'Node', 'Element', 'SVGElement', 'CSS',
  ]);

  const undeclared = [];

  for (const file of walkSourceFiles(SRC_DIR)) {
    const code = fs.readFileSync(file, 'utf8');
    const rel = path.relative(SRC_DIR, file);
    const ast = parser.parse(code, {
      sourceType: 'module',
      plugins: ['jsx', 'importMeta'],
    });

    traverse(ast, {
      Program(p) {
        for (const name of Object.keys(p.scope.globals)) {
          if (!BROWSER_GLOBALS.has(name)) {
            const line = p.scope.globals[name].loc?.start.line ?? '?';
            undeclared.push(`${rel}:${line} -> ${name}`);
          }
        }
      },
      JSXOpeningElement(p) {
        const node = p.node.name;
        if (node.type === 'JSXIdentifier' && /^[A-Z]/.test(node.name) && !p.scope.hasBinding(node.name)) {
          undeclared.push(`${rel}:${node.loc?.start.line ?? '?'} -> <${node.name}>`);
        }
      },
    });
  }

  assert.deepEqual(undeclared, []);
});
