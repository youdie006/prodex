/**
 * Turn a blocked consult into a bug report.
 *
 * Reports from this project have been arriving as chat messages: a session on
 * another machine hit a broken picker three different ways, and the only record
 * was the conversation it was typed into. A blocked receipt already holds what a
 * report needs, so this reads that rather than asking anyone to retype it.
 */

export interface BlockedConsultLike {
  task_id: string;
  status: string;
  blocker?: {
    code?: string;
    message?: string;
    retryable?: boolean;
    next_step?: string;
  };
}

export interface ReportEnvironment {
  version: string;
  platform: string;
  nodeVersion: string;
}

export interface IssueReport {
  title: string;
  body: string;
  labels: string[];
}

/**
 * Which part of prodex a blocker belongs to.
 *
 * Guessing from the code prefix keeps this honest about what it does not know:
 * an unfamiliar code gets no area label rather than a wrong one.
 */
export function issueAreaLabel(code: string): string | undefined {
  if (/^(browser|chatgpt|send|model|response|tab|composer|login|captcha|deep_research|pro_mode)/.test(code)) return "area:browser";
  if (/^(bridge|store|receipt|task|result|session|artifact)/.test(code)) return "area:bridge";
  if (/^(config|setup|token|mcp|server)/.test(code)) return "area:config";
  return undefined;
}

/**
 * Build the report. Only the failure travels: never the prompt, the answer, or
 * the summary, because a public issue must not become where a private consult
 * leaks. Everything included here is either environment or blocker metadata.
 */
export function buildIssueReport(consult: BlockedConsultLike, environment: ReportEnvironment): IssueReport {
  if (consult.status !== "blocked" || !consult.blocker) {
    throw new Error(`${consult.task_id} is not a failure (status ${consult.status}), so there is nothing to report.`);
  }
  const code = (consult.blocker.code ?? "unknown").trim();
  const message = (consult.blocker.message ?? "").trim();
  const area = issueAreaLabel(code);
  const body = [
    "A consult was blocked. Filed from its receipt, so the prompt and the answer are not included.",
    "",
    "| | |",
    "| --- | --- |",
    `| blocker | \`${code}\` |`,
    `| message | ${message || "(none)"} |`,
    `| retryable | ${consult.blocker.retryable === true ? "yes" : "no"} |`,
    `| prodex | ${environment.version} |`,
    `| platform | ${environment.platform} |`,
    `| node | ${environment.nodeVersion} |`,
    "",
    ...(consult.blocker.next_step ? ["What it told the caller to do:", "", `> ${consult.blocker.next_step}`, ""] : []),
    "Receipt (local, not attached): " + consult.task_id
  ].join("\n");
  return {
    title: `${code}: ${message || "blocked consult"}`.slice(0, 120),
    body,
    labels: ["bug", ...(area ? [area] : [])]
  };
}

export interface OpenIssueSummary {
  number: number;
  title: string;
}

/**
 * Whether this report is news.
 *
 * A watchdog that files on every run turns one broken thing into a daily pile of
 * identical issues, and the pile is what makes people stop reading them. Same
 * blocker code, still open: add to it instead of opening another.
 */
export function chooseIssueAction(
  openIssues: readonly OpenIssueSummary[],
  report: IssueReport
): { action: "create" } | { action: "comment"; number: number } {
  const code = report.title.split(":")[0]?.trim();
  if (!code) return { action: "create" };
  const existing = openIssues.find((issue) => issue.title.split(":")[0]?.trim() === code);
  return existing ? { action: "comment", number: existing.number } : { action: "create" };
}

/** The repository a report goes to when the caller does not name one. */
export const PRODEX_ISSUE_REPO = "youdie006/prodex";

/**
 * File the report through the `gh` CLI, which already holds the user's GitHub
 * auth. Shelling out beats storing a token: prodex never asks for one, and
 * whatever `gh` is allowed to do is exactly what this is allowed to do.
 */
export async function fileGitHubIssue(repo: string, report: IssueReport): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  try {
    const open = await run("gh", ["issue", "list", "--repo", repo, "--state", "open", "--limit", "100", "--json", "number,title"], {
      timeout: 60_000
    }).then(
      ({ stdout }) => JSON.parse(stdout || "[]") as OpenIssueSummary[],
      () => [] as OpenIssueSummary[]
    );
    const decision = chooseIssueAction(open, report);
    if (decision.action === "comment") {
      await run("gh", ["issue", "comment", String(decision.number), "--repo", repo, "--body", report.body], { timeout: 60_000 });
      return `commented on existing #${decision.number}`;
    }
    const args = ["issue", "create", "--repo", repo, "--title", report.title, "--body", report.body];
    for (const label of report.labels) args.push("--label", label);
    const { stdout } = await run("gh", args, { timeout: 60_000 });
    return stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? "(no url returned)";
  } catch (error) {
    const detail = error instanceof Error ? error.message.split(/\r?\n/)[0] : String(error);
    throw new Error(
      `Could not file the issue with \`gh\`: ${detail}. Check \`gh auth status\`, or copy the report above into a new issue by hand.`
    );
  }
}
