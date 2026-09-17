import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../containers/browser/", import.meta.url);

describe("experimental container browser isolation", () => {
  it("keeps CDP, host profiles, desktop sockets and Docker authority private", () => {
    const config = JSON.parse(readFileSync(new URL("compose.json", root), "utf8"));
    const service = config.services.browser;
    expect(Object.keys(config.services)).toEqual(["browser"]);
    expect(service.user).toBe("1000:1000");
    expect(service.hostname).toBe("prodex-browser");
    expect(service.cap_drop).toEqual(["ALL"]);
    expect(service.cap_add).toBeUndefined();
    expect(service.privileged).toBeUndefined();
    expect(service.network_mode).toBeUndefined();
    expect(service.pid).toBeUndefined();
    expect(service.read_only).toBe(true);
    expect(service.security_opt).toEqual(["no-new-privileges:true", "seccomp=./seccomp.json"]);
    expect(service.ports).toEqual(["127.0.0.1:${PRODEX_VIEWER_PORT:-39333}:6080"]);
    expect(service.volumes).toEqual(["browser-home:/home/node"]);
    expect(service.restart).toBe("no");
    expect(service.environment.PRODEX_NO_AUTO_LOGIN).toBe("1");
    expect(service.environment.PRODEX_HEADLESS).toBe("0");
    expect(service.environment.DISPLAY).toBe(":99");
    expect(service.environment.PRODEX_CHROME).toBe("/usr/lib/chromium/chromium");
  });

  it("retains syscall filtering and enables only an attributed upstream profile", () => {
    const profile = JSON.parse(readFileSync(new URL("seccomp.json", root), "utf8"));
    expect(profile.defaultAction).toBe("SCMP_ACT_ERRNO");
    expect(profile.syscalls.some((rule: { names: string[]; action: string }) =>
      rule.action === "SCMP_ACT_ALLOW" && ["clone", "setns", "unshare", "chroot"].every(name => rule.names.includes(name))
    )).toBe(true);
    const notice = readFileSync(new URL("NOTICE.md", root), "utf8");
    expect(notice).toContain("18205280b6112a4a08238195942c4fa30c199a62");
    expect(notice).toContain("Apache-2.0");
  });

  it("uses the packaged binary instead of Debian's shared-memory and GPU flag wrapper", () => {
    const dockerfile = readFileSync(new URL("Dockerfile", root), "utf8");
    expect(dockerfile).toContain("PRODEX_CHROME=/usr/lib/chromium/chromium");
    expect(dockerfile).toContain("test -x /usr/lib/chromium/chromium");
  });

  it("uses an allowlisted build context and does not disable browser protections", () => {
    const dockerfile = readFileSync(new URL("Dockerfile", root), "utf8");
    const ignore = readFileSync(new URL("Dockerfile.dockerignore", root), "utf8");
    expect(ignore.split(/\r?\n/)[0]).toBe("**");
    expect(ignore).not.toMatch(/!\.git|!\.bridge|!\.env|!Makefile|!node_modules/);
    expect(dockerfile).toContain("USER node");
    expect(dockerfile).not.toMatch(/--no-sandbox|--disable-setuid-sandbox|AutomationControlled|password-store=basic/);
    expect(dockerfile).toContain("chromium");
    expect(dockerfile).toContain("xvfb");
    expect(dockerfile).toContain("COPY prodex.mjs ./");
    expect(dockerfile).toContain("ln -s /app/prodex.mjs /usr/local/bin/prodex");
    expect(ignore).toContain("!prodex.mjs");
    const attributes = readFileSync(new URL("../../.gitattributes", root), "utf8");
    expect(attributes).toContain("/prodex.mjs text eol=lf");
    expect(attributes).toContain("/containers/browser/* text eol=lf");
  });
});
