import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

test('focus target harness never launches an internal render-load browser', async () => {
  const source = await readFile(new URL('./focus-probe.mjs', import.meta.url), 'utf8');
  const launchedRoles = [...source.matchAll(/launchOwnedBrowser\(\{ role: '([^']+)'/g)]
    .map((match) => match[1]);

  assert.deepEqual([...new Set(launchedRoles)], ['target-prime', 'target-measured']);
  assert.doesNotMatch(source, /single-render-load/);
  assert.doesNotMatch(source, /function renderFixtureHtml/);
  assert.match(source, /selectFocusTrials\(process\.env\.PRODEX_FOCUS_TRIAL\)/);
  assert.match(source, /parseExternalLoad\(process\.env\.PRODEX_FOCUS_EXTERNAL_LOAD\)/);
});
