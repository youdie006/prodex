import { describe, expect, it } from "vitest";

import { createBrowserCompatibilityEvidence } from "../scripts/browser-compatibility.mjs";

const completeCapabilities = {
  runtimeEnabled: true,
  runtimeEvaluated: true,
  domEnabled: true,
  keyboardInput: true,
  mouseInput: true,
  fileAttachment: true,
  profileRestartMarker: true
};

function completeInput() {
  return {
    cdpVersion: {
      Browser: "Chrome/145.0.7632.76",
      "Protocol-Version": "1.3",
      "User-Agent": "private raw metadata",
      webSocketDebuggerUrl: "ws://127.0.0.1:9333/devtools/browser/private"
    },
    platform: "linux",
    arch: "x64",
    headlessProcess: true,
    capabilities: { ...completeCapabilities }
  };
}

describe("browser compatibility evidence", () => {
  it("emits compact runtime evidence without raw CDP or profile data", () => {
    const evidence = createBrowserCompatibilityEvidence(completeInput());

    expect(evidence).toEqual({
      browser: "Chrome/145.0.7632.76",
      protocol: "1.3",
      platform: "linux",
      arch: "x64",
      headless_process: true,
      runtime_enable: true,
      runtime_evaluate: true,
      dom: true,
      keyboard: true,
      mouse: true,
      file_attachment: true,
      profile_restart: "synthetic_marker"
    });
    expect(JSON.stringify(evidence)).not.toMatch(/User-Agent|webSocketDebuggerUrl|private raw metadata|devtools\/browser/i);
  });

  it("emits headed process evidence without claiming the process was headless", () => {
    const evidence = createBrowserCompatibilityEvidence({
      ...completeInput(),
      headlessProcess: false,
      headedProcess: true
    });

    expect(evidence).toEqual({
      browser: "Chrome/145.0.7632.76",
      protocol: "1.3",
      platform: "linux",
      arch: "x64",
      headed_process: true,
      runtime_enable: true,
      runtime_evaluate: true,
      dom: true,
      keyboard: true,
      mouse: true,
      file_attachment: true,
      profile_restart: "synthetic_marker"
    });
    expect(evidence).not.toHaveProperty("headless_process");
  });

  it("rejects contradictory inspected process mode evidence", () => {
    expect(() => createBrowserCompatibilityEvidence({
      ...completeInput(),
      headedProcess: true
    })).toThrow(/conflicting.*process/i);
  });

  it("reports a syntactically valid protocol without inferring broad version support", () => {
    const evidence = createBrowserCompatibilityEvidence({
      ...completeInput(),
      cdpVersion: { Browser: "Chromium/90.0", "Protocol-Version": "0.9" }
    });

    expect(evidence).toMatchObject({ browser: "Chromium/90.0", protocol: "0.9" });
  });

  it("rejects evidence derived without an inspected headless process", () => {
    expect(() => createBrowserCompatibilityEvidence({
      ...completeInput(),
      headlessProcess: false
    })).toThrow(/headless process/i);
  });

  it.each([
    [{ "Protocol-Version": "1.3" }, /browser metadata/i],
    [{ Browser: "Chrome/145.0.7632.76" }, /protocol metadata/i],
    [{ Browser: "Firefox/147.0", "Protocol-Version": "1.3" }, /chromium-compatible/i],
    [{ Browser: "Chrome/not-a-version", "Protocol-Version": "1.3" }, /chromium-compatible/i],
    [{ Browser: "Chrome/145.0.7632.76", "Protocol-Version": "not-a-version" }, /protocol metadata/i]
  ])("rejects incomplete or incompatible CDP metadata: %j", (cdpVersion, message) => {
    expect(() => createBrowserCompatibilityEvidence({
      ...completeInput(),
      cdpVersion
    })).toThrow(message);
  });

  it.each([
    ["runtimeEnabled", "Runtime.enable"],
    ["runtimeEvaluated", "Runtime.evaluate"],
    ["domEnabled", "DOM"],
    ["keyboardInput", "keyboard"],
    ["mouseInput", "mouse"],
    ["fileAttachment", "file attachment"],
    ["profileRestartMarker", "profile restart"]
  ] as const)("rejects a missing %s capability proof", (capability, message) => {
    expect(() => createBrowserCompatibilityEvidence({
      ...completeInput(),
      capabilities: {
        ...completeCapabilities,
        [capability]: false
      }
    })).toThrow(new RegExp(message, "i"));
  });

  it.each([
    ["platform", ""],
    ["arch", "x64\nforged=true"]
  ] as const)("rejects invalid %s evidence", (field, value) => {
    expect(() => createBrowserCompatibilityEvidence({
      ...completeInput(),
      [field]: value
    })).toThrow(new RegExp(field, "i"));
  });
});
