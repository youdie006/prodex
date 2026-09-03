// Decisions the repository bot makes about incoming issues and pull requests.
//
// Kept as pure functions with no dependencies so the workflows stay thin and the
// behaviour is testable without GitHub: a bot whose judgement only runs in CI is
// a bot nobody can check.

/** Labels this repository actually has. Asking for one it lacks fails the run. */
export const EXISTING_LABELS = new Set([
  "bug",
  "documentation",
  "duplicate",
  "enhancement",
  "help wanted",
  "good first issue",
  "invalid",
  "question",
  "wontfix"
]);

const REPRO_FIELDS = [
  { key: "prodex version", pattern: /\b\d+\.\d+\.\d+\b|prodex[^\n]*\d+\.\d+/i },
  { key: "platform", pattern: /\b(linux|darwin|macos|mac os|windows|wsl)\b/i },
  { key: "the command you ran", pattern: /prodex\s+\w|npx\s+.*prodex/i }
];

/**
 * What to do with a newly opened issue.
 *
 * Only labels the repository already has are used, and the comment asks for
 * exactly the fields that are missing - a bot that asks for everything every
 * time trains people to skip reading it.
 */
export function triageIssue(input) {
  const text = `${input.title ?? ""}\n${input.body ?? ""}`;
  const labels = [];
  // Inflected forms are how people actually write: "it fails", "throws errors".
  // Matching only the bare stems missed the most common phrasing entirely.
  const looksLikeBug = /\b(errors?|fail(s|ed|ing|ure)?|crash(es|ed|ing)?|blocked|broken|traceback|exception)\b/i.test(text);
  const looksLikeQuestion = /\?\s*$|^\s*(how|can i|is it possible|does)\b/im.test(text);
  if (looksLikeBug) labels.push("bug");
  else if (looksLikeQuestion) labels.push("question");
  if (/\b(readme|docs?|documentation|typo)\b/i.test(text)) labels.push("documentation");
  if (/\b(feature|support for|would be nice|please add|enhancement)\b/i.test(text)) labels.push("enhancement");

  const missing = looksLikeBug ? REPRO_FIELDS.filter((field) => !field.pattern.test(text)).map((field) => field.key) : [];
  const comment = missing.length
    ? [
        "Thanks for the report. To reproduce this I still need:",
        "",
        ...missing.map((field) => `- ${field}`),
        "",
        "If the failure came from a consult, `prodex pro report-issue` builds this from the receipt -",
        "it includes the blocker, the version and the platform, and never includes your prompt or the answer."
      ].join("\n")
    : undefined;

  return {
    labels: labels.filter((label) => EXISTING_LABELS.has(label)),
    ...(comment ? { comment } : {})
  };
}

const AREA_RULES = [
  { area: "browser adapter", pattern: /^src\/(chatgpt-browser|picker-interaction)\.ts$/ },
  { area: "bridge store", pattern: /^src\/(store|repo|repo-write)\.ts$/ },
  { area: "CLI", pattern: /^src\/cli.*\.ts$/ },
  { area: "MCP", pattern: /^src\/mcp.*\.ts$/ },
  { area: "release tooling", pattern: /^(scripts\/|\.github\/workflows\/)/ },
  { area: "tests", pattern: /^tests\// }
];

/** Paths where a change deserves a closer read before merging. */
const SENSITIVE = [
  { why: "touches the receipt/integrity path", pattern: /^src\/store\.ts$/ },
  { why: "touches what gets written to a repo", pattern: /^src\/repo-write\.ts$/ },
  { why: "touches how the package is published", pattern: /^(\.github\/workflows\/publish\.yml|scripts\/release-.*\.mjs)$/ }
];

/**
 * A first pass over a pull request: what it touches, whether it carries tests,
 * and which parts warrant a careful read. It states findings and never approves
 * - the judgement stays with a person.
 */
export function reviewPullRequest(files) {
  const paths = files.map((file) => file.path);
  const areas = AREA_RULES.filter((rule) => paths.some((p) => rule.pattern.test(p))).map((rule) => rule.area);
  const sensitive = SENSITIVE.filter((rule) => paths.some((p) => rule.pattern.test(p))).map((rule) => rule.why);
  const touchesTests = paths.some((p) => p.startsWith("tests/"));
  const touchesSource = paths.some((p) => p.startsWith("src/") || p.startsWith("scripts/"));
  const changed = files.reduce((sum, file) => sum + (file.additions ?? 0) + (file.deletions ?? 0), 0);

  const notes = [];
  if (touchesSource && !touchesTests) {
    notes.push("Source changed with no test changes. If this fixes something, a test that fails without the fix is the proof.");
  }
  for (const why of sensitive) notes.push(`Careful read: ${why}.`);

  return {
    areas,
    sensitive,
    touchesTests,
    body: [
      "## What this touches",
      "",
      areas.length ? areas.map((area) => `- ${area}`).join("\n") : "- (nothing recognised)",
      "",
      `${files.length} file(s), ${changed} line(s) changed. Tests ${touchesTests ? "changed" : "unchanged"}.`,
      ...(notes.length ? ["", "## Worth a look", "", ...notes.map((note) => `- ${note}`)] : []),
      "",
      "This is an automated first pass, not a review. CI is the gate; a person decides."
    ].join("\n")
  };
}
