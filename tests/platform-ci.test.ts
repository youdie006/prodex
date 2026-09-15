import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");
const ciPath = path.join(repoRoot, ".github", "workflows", "ci.yml");

describe("platform CI", () => {
  it("requires the same native matrix before publishing a release", async () => {
    const workflow = await readFile(ciPath, "utf8");
    const publish = await readFile(path.join(repoRoot, ".github", "workflows", "publish.yml"), "utf8");
    expect(workflow).toContain("workflow_call:");
    expect(publish).toContain("uses: ./.github/workflows/ci.yml");
    expect(publish).toContain("needs: verify-platforms");
  });
  it("runs release verification on the supported OS and Node.js matrix", async () => {
    const workflow = (await readFile(ciPath, "utf8")).replaceAll("\r\n", "\n");
    const matrixRows = [...workflow.matchAll(/^\s+- name: (.+)\n\s+os: (\S+)\n\s+node: (\d+)$/gm)].map(
      ([, name, os, node]) => ({ name, os, node: Number(node) })
    );

    expect(matrixRows).toEqual([
      { name: "Ubuntu 24.04 / Node.js 20", os: "ubuntu-24.04", node: 20 },
      { name: "Ubuntu 24.04 / Node.js 22", os: "ubuntu-24.04", node: 22 },
      { name: "Ubuntu 24.04 / Node.js 24", os: "ubuntu-24.04", node: 24 },
      { name: "macOS 15 arm64 / Node.js 22", os: "macos-15", node: 22 },
      { name: "macOS 15 Intel / Node.js 22", os: "macos-15-intel", node: 22 },
      { name: "Windows Server 2025 x64 / Node.js 22", os: "windows-2025", node: 22 },
    ]);
    expect(workflow).toContain("fail-fast: false");
    expect(workflow).toContain("runs-on: ${{ matrix.os }}");
    expect(workflow).toContain("node-version: ${{ matrix.node }}");
  });

  it("keeps every matrix job bounded and fully verified", async () => {
    const workflow = (await readFile(ciPath, "utf8")).replaceAll("\r\n", "\n");

    const timeout = workflow.match(/timeout-minutes: (\d+)/);
    expect(Number(timeout?.[1])).toBeGreaterThanOrEqual(30);
    expect(Number(timeout?.[1])).toBeLessThanOrEqual(40);
    expect(workflow).toContain("platform=' + process.platform");
    expect(workflow).toContain("arch=' + process.arch");
    expect(workflow).toContain("if: runner.os == 'Linux'");
    expect(workflow).toContain("sudo apt-get install -y ripgrep");
    expect(workflow).toContain("if: runner.os == 'macOS'");
    expect(workflow).toContain("brew install ripgrep");
    expect(workflow).toContain("if: runner.os == 'Windows'");
    expect(workflow).toContain("choco install ripgrep -y --no-progress");
    expect(workflow).toContain("run: npm run build");
    expect(workflow).toContain("run: npm run release:check -- --metadata-only");
    expect(workflow).toContain("run: npm run smoke:browser");
    expect(workflow).toContain("path: test-results/vitest.json");
    expect(workflow).toContain("run: npm run release:verify");
    expect(workflow).not.toContain("continue-on-error");
  });
});
