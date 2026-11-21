import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Supplemental stylesheet regressions. The behavioral VM suite lives in
// client.test.js; these guards cover actual CSS declarations/masks which a mock
// DOM intentionally does not pretend to paint or animate.
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const css = source.slice(source.indexOf('const CSS = `') + 13, source.indexOf('    // Pin icon SVG'));
const panel = source.slice(source.indexOf('const PANEL_CSS = `'), source.indexOf('    const STAR_SVG'));

test('all four resolved masks are defined once and no generic initialization overrides them', () => {
  for (const state of ['waiting','error','running','done']) {
    assert.equal((css.match(new RegExp(`--dsh-order-glyph-${state}:`, 'g')) || []).length,1);
    assert.match(css,new RegExp(`\\[data-dsh-order-state="${state}"\\][^{]*\\{[^}]*--dsh-order-mask:var\\(--dsh-order-glyph-${state}\\)`));
  }
  assert.doesNotMatch(css,/--dsh-order-mask\s*:\s*none/,'a higher-specificity generic mark must not shadow state masks');
  assert.match(css,/\.dsh-order-native-mark:not\(svg\)\[data-dsh-order-state\]::after, \.dsh-order-session-mark::after/);
  assert.match(css,/-webkit-mask:var\(--dsh-order-mask\) center \/ contain no-repeat/);
  assert.match(css,/mask:var\(--dsh-order-mask\) center \/ contain no-repeat/);
});

test('native and fallback status spins both stop under reduced motion; other ornaments also stop', () => {
  const reduce=css.slice(css.lastIndexOf('@media (prefers-reduced-motion:reduce)'));
  assert.match(reduce,/\.dsh-order-native-mark:not\(svg\)\[data-dsh-order-state="running"\]::after/);
  assert.match(reduce,/\.dsh-order-session-mark\[data-dsh-order-state="running"\]::after\s*\{ animation:none !important;/);
  assert.match(reduce,/transition:none; transform:none !important/);
  assert.match(css,/prefers-reduced-motion: reduce[\s\S]*dsh-folder-cell[\s\S]*animation: none/);
});

test('SVG replacement hides and stops the native SVG itself, without expecting SVG pseudo-element boxes', () => {
  assert.match(css,/\.dsh-order-native-svg-hidden\s*\{ display:none !important; animation:none !important;/);
  assert.match(css,/\.dsh-order-native-svg-hidden \*\s*\{ animation:none !important;/);
  assert.doesNotMatch(css,/\.dsh-order-native-mark\[data-dsh-order-state[^}]*::(?:after|before)/);
  assert.match(css,/\.dsh-order-session-mark\[data-dsh-order-state="idle"\]::after/);
});

test('tree has exactly one 12px tray step and only resets native indent, never base row padding', () => {
  assert.match(panel,/margin-inline-start:12px/);
  assert.match(panel,/\[data-dsh-order-tray-row\] \{ --dsh-workspace-indent:0px; \}/);
  const tray=panel.slice(panel.indexOf('The tray owns'),panel.indexOf('.dsh-order-panel-note'));
  assert.doesNotMatch(tray,/padding(?:-inline-start|-left)\s*:/);
  assert.doesNotMatch(tray,/>\s*span|span\s*>/,'wrapper depth is not part of the layout contract');
});

test('the card builds its own controls and imports no private Client UI module', () => {
  // The Harness Client UI packages are internal: their exports change without
  // notice, and a missing export would silently blank the whole card. The card
  // must therefore request only the baseline React modules.
  const requires = [...source.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map(match => match[1]);
  for (const name of requires) {
    assert.ok(!name.startsWith('@deepseek-ai/'), `client must not require the private module ${name}`);
  }
  assert.ok(requires.includes('react'));
  assert.ok(requires.includes('react/jsx-runtime'));
  // The controls are real elements with the shipped semantics.
  assert.match(source, /role: 'switch'/);
  assert.match(source, /'aria-checked': checked === true/);
  assert.match(source, /'aria-expanded': open === true/);
  assert.match(source, /role: 'button'/);
  // Their styling reads host theme tokens only.
  assert.match(panel, /\.dsh-order-panel-switch\s*\{[\s\S]*?var\(--dsw-alias-/);
  assert.match(panel, /\.dsh-order-panel-switch\[aria-checked="true"\]\s*\{[^}]*--dsw-alias-brand-primary/);
  assert.match(panel, /\.dsh-order-panel-switch:focus-visible\s*\{[^}]*--dsw-focus-ring-width/);
});
