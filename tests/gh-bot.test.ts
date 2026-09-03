import { describe, expect, it } from "vitest";

// @ts-expect-error - plain .mjs, deliberately dependency-free so the workflows stay thin
import { EXISTING_LABELS, reviewPullRequest, triageIssue } from "../scripts/gh-bot.mjs";

describe("triage of an incoming issue", () => {
  it("asks only for the repro fields that are missing", () => {
    // A bot that asks for everything every time trains people to skip reading it.
    const result = triageIssue({
      title: "consult fails with browser_send_failed",
      body: "Running `prodex pro browser ask` on linux and it errors every time."
    });
    expect(result.labels).toContain("bug");
    expect(result.comment).toContain("prodex version");
    expect(result.comment).not.toContain("- platform");
    expect(result.comment).not.toContain("- the command you ran");
  });

  it("says nothing when the report already has what it needs", () => {
    const result = triageIssue({
      title: "crash on send",
      body: "prodex 0.36.5 on linux, ran `prodex pro browser ask hi`, got an exception."
    });
    expect(result.labels).toContain("bug");
    expect(result.comment).toBeUndefined();
  });

  it("only ever asks for labels this repository has", () => {
    for (const sample of [
      { title: "how do I pin a project?", body: "Is it possible to set a default?" },
      { title: "typo in README", body: "docs say --modell" },
      { title: "please add support for Gemini", body: "would be nice" }
    ]) {
      for (const label of triageIssue(sample).labels) {
        expect(EXISTING_LABELS.has(label), `${label} does not exist in the repo`).toBe(true);
      }
    }
  });

  it("does not label a question as a bug", () => {
    const result = triageIssue({ title: "How do I use --effort?", body: "Can I set it per repo?" });
    expect(result.labels).toContain("question");
    expect(result.labels).not.toContain("bug");
    expect(result.comment).toBeUndefined();
  });
});

describe("first pass over a pull request", () => {
  it("names what the change touches", () => {
    const review = reviewPullRequest([
      { path: "src/chatgpt-browser.ts", additions: 20, deletions: 4 },
      { path: "tests/chatgpt-browser.test.ts", additions: 30, deletions: 0 }
    ]);
    expect(review.areas).toContain("browser adapter");
    expect(review.touchesTests).toBe(true);
    expect(review.body).toContain("54 line(s) changed");
  });

  it("points out source changed without tests", () => {
    const review = reviewPullRequest([{ path: "src/cli-pro.ts", additions: 40, deletions: 2 }]);
    expect(review.body).toMatch(/no test changes/i);
  });

  it("flags the paths where a mistake is expensive", () => {
    const review = reviewPullRequest([{ path: "src/store.ts", additions: 5, deletions: 5 }]);
    expect(review.sensitive.join(" ")).toMatch(/receipt|integrity/i);
  });

  it("never claims to approve", () => {
    const review = reviewPullRequest([{ path: "README.md", additions: 1, deletions: 1 }]);
    expect(review.body).not.toMatch(/\bLGTM\b|approv/i);
    expect(review.body).toMatch(/a person decides/i);
  });
});
