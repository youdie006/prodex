// Render assets/cli-banner.png from docs/cli-banner.html with a Playwright
// chromium. The page is 1200x720 CSS pixels, captured at 2x.
//
//   PW_DIR=/path/to/node_modules CHROME=/path/to/chrome node scripts/make-banner.mjs
//
// PW_DIR is a directory that contains a `playwright` package; CHROME is the
// chromium binary that matches it. Both default to Playwright's own cache.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const require = createRequire(process.env.PW_DIR ? path.join(process.env.PW_DIR, "x.js") : import.meta.url);
const { chromium } = require("playwright");
const src = "file://" + path.join(root, "docs", "cli-banner.html");
const out = path.join(root, "assets", "cli-banner.png");

const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 720 }, deviceScaleFactor: 2 });
  await page.goto(src, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(200);
  await page.screenshot({ path: out });
  console.log("wrote", path.relative(root, out));
} finally {
  await browser.close();
}
