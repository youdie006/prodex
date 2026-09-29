import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'vitest';

test('load holder is single-browser, loopback-only, motion-gated, and bounded', async () => {
  const source = await readFile(new URL('./load-hold.mjs', import.meta.url), 'utf8');

  assert.equal([...source.matchAll(/openChatGptBrowser\(/g)].length, 1);
  assert.match(source, /await mkdir\(profileDir, \{ recursive: true, mode: 0o700 \}\)/);
  assert.match(source, /renderFixtureHtml\(/);
  assert.match(source, /second\.frames > first\.frames/);
  assert.match(source, /second\.lastFrameTimeMs > first\.lastFrameTimeMs/);
  assert.match(source, /console\.log\(`READY \$\{JSON\.stringify\(readyRecord\)\}`\)/);
  assert.match(source, /const finalMotion = await verifyExistingMotion\(browser, fixture\.url\)/);
  assert.match(source, /const finalProcessCheck = verifyOwnedBrowserProcesses\(browser\)/);
  const existingMotionHelper = /async function verifyExistingMotion[\s\S]*?\n}/.exec(source)?.[0];
  assert.ok(existingMotionHelper);
  assert.doesNotMatch(existingMotionHelper, /Page\.navigate/);
  assert.match(source, /'SIGINT', 'SIGTERM'/);
  assert.match(source, /loadFinalRecord\(/);
  assert.doesNotMatch(source, /https:\/\//);
});
