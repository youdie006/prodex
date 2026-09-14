import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("does not ship hidden ChatGPT endpoint or browser credential extraction code", async () => {
  const root = fileURLToPath(new URL("../src/", import.meta.url));
  const forbidden = /\/backend-api\b|\/api\/auth\/session\b|\.accessToken\b|document\.cookie\b/;
  const violations: string[] = [];
  async function scan(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await scan(file);
      else if (entry.isFile() && entry.name.endsWith(".ts") && forbidden.test(await readFile(file, "utf8"))) {
        violations.push(path.relative(root, file));
      }
    }
  }
  await scan(root);
  expect(violations, "AGENTS.md forbids internal ChatGPT endpoints and credential extraction").toEqual([]);
});
