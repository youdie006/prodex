import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { execNpm } from "../scripts/npm-command.mjs";

describe("execNpm", () => {
  it("runs npm's JavaScript CLI with literal paths and arguments", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex npm argv & "));
    const npmCli = path.join(root, "npm cli & literal.mjs");
    const argvLog = path.join(root, "argv.json");
    const shellMarker = path.join(root, "shell-expanded.txt");
    await writeFile(
      npmCli,
      [
        'import { writeFileSync } from "node:fs";',
        "writeFileSync(process.env.PRODEX_NPM_ARGV_LOG, JSON.stringify(process.argv.slice(2)));",
        'process.stdout.write("fake npm ok\\n");'
      ].join("\n"),
      "utf8"
    );
    const args = ["pack", "path with spaces", `& echo expanded > ${shellMarker}`, "$(echo substituted)", "^|<literal>"];

    const result = await execNpm(args, {
      cwd: root,
      env: { ...process.env, npm_execpath: npmCli, PRODEX_NPM_ARGV_LOG: argvLog }
    });

    expect(result.stdout).toBe("fake npm ok\n");
    await expect(readFile(argvLog, "utf8")).resolves.toBe(JSON.stringify(args));
    await expect(access(shellMarker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("finds the npm CLI for direct prodex launches without npm_execpath", async () => {
    const env = { ...process.env };
    delete env.npm_execpath;

    const result = await execNpm(["--version"], { env });

    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("ignores a competing package manager in npm_execpath", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex npm manager "));
    const pnpmCli = path.join(root, "pnpm.cjs");
    const npmCli = path.join(root, "node_modules", "npm", "bin", "npm-cli.js");
    await mkdir(path.dirname(npmCli), { recursive: true });
    await writeFile(pnpmCli, 'throw new Error("pnpm must not run");\n', "utf8");
    await writeFile(npmCli, 'process.stdout.write("npm fallback ok\\n");\n', "utf8");

    const result = await execNpm(["--version"], {
      cwd: root,
      env: { ...process.env, PATH: root, npm_execpath: pnpmCli }
    });

    expect(result.stdout).toBe("npm fallback ok\n");
  });
});
