import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { buildDryRunBundle } from "../src/bundle.js";
import { readRepoFile } from "../src/repo.js";

// Measured 2026-10-20: a file saved by Windows Notepad as "Unicode" (UTF-16 LE
// with a BOM) was refused by --file as "not a text file". It was read as
// UTF-8, so every other byte came back as a NUL control character.
async function repoWith(name: string, bytes: Buffer): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "prodex-utf16-"));
  await writeFile(path.join(root, name), bytes);
  return root;
}

const utf16be = (text: string) => {
  const le = Buffer.from(text, "utf16le");
  for (let i = 0; i + 1 < le.length; i += 2) [le[i], le[i + 1]] = [le[i + 1], le[i]];
  return Buffer.concat([Buffer.from([0xfe, 0xff]), le]);
};

describe("a UTF-16 text file", () => {
  it("is read as text when it starts with a little-endian BOM", async () => {
    const root = await repoWith("notes.txt", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("KEY=utf16-33\r\n한국어 줄\r\n", "utf16le")]));
    const result = await readRepoFile(root, "notes.txt");
    expect(result.content).toBe("KEY=utf16-33\n한국어 줄");
    const bundle = await buildDryRunBundle(root, { prompt: "Read it.", files: ["notes.txt"] });
    expect(bundle.sendText).toContain("KEY=utf16-33");
  });

  it("is read as text when it starts with a big-endian BOM", async () => {
    const root = await repoWith("be.txt", utf16be("KEY=be-44\n"));
    expect((await readRepoFile(root, "be.txt")).content).toBe("KEY=be-44");
  });

  it("still refuses a binary file that has no BOM", async () => {
    const root = await repoWith("blob.bin", Buffer.from([0, 1, 2, 3, 0, 5, 6, 0, 8, 0, 0, 11, 0, 0, 0, 0]));
    await expect(buildDryRunBundle(root, { prompt: "x", files: ["blob.bin"] })).rejects.toThrow(/not a text file/);
  });
});
