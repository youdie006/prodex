import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { shellQuote } from "../src/cli-args.js";

describe("shellQuote", () => {
  it("uses PowerShell literal quoting for Windows metacharacters and apostrophes", () => {
    const value = "C:\\Program Files\\O'Brien\\$cache `tick`\nnext & final";

    expect(shellQuote(value, "win32")).toBe("'C:\\Program Files\\O''Brien\\$cache `tick`\nnext & final'");
  });

  it("keeps POSIX literal quoting outside Windows", () => {
    expect(shellQuote("O'Brien $HOME", "linux")).toBe("'O'\\''Brien $HOME'");
  });

  it.each([
    "prodex",
    "C:/tools/node.exe",
    "https://localhost:8443/path",
    "name=value"
  ])("leaves a shell-safe literal unchanged: %s", (value) => {
    expect(shellQuote(value, "win32")).toBe(value);
  });

  it.each(["@args", "@literal"])("quotes a leading PowerShell splatting token: %s", (value) => {
    expect(shellQuote(value, "win32")).toBe(`'${value}'`);
  });

  it("leaves an embedded at-sign in a plain email address unchanged", () => {
    expect(shellQuote("person@example.com", "win32")).toBe("person@example.com");
  });

  it.skipIf(process.platform !== "win32")("round-trips a complex literal through native PowerShell", () => {
    const values = [
      "C:\\Program Files\\O'Brien\\$cache `tick`\nnext & final",
      "@args",
      "@literal",
      "person@example.com",
      "C:/tools/node.exe"
    ];

    for (const value of values) {
      const quoted = shellQuote(value);
      const command = "function Write-Argument { param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Value) " +
        "[Console]::Out.Write($Value[0]) }; Write-Argument " + quoted;
      expect(execFileSync(
        "powershell.exe",
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
        { encoding: "utf8" }
      )).toBe(value);
    }
  });
});
