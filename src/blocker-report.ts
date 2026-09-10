/**
 * Rank what actually blocks consults, across every bridge root on the machine.
 *
 * Half of every consult here ends in a blocker, and until now asking WHICH
 * failure dominates meant writing a throwaway script: `pro list` reads a single
 * repo, and the registry that knows where the others are had no reader. Pure
 * on purpose - the reading lives in the command, so the ranking can be tested
 * without a filesystem.
 */

/** One consult, reduced to what ranking needs. */
export interface BlockerConsult {
  repo: string;
  createdAt?: string;
  blocker?: { code: string; message: string };
}

export interface BlockerGroup {
  /** The blocker code, or `code: cause` where the code alone names nothing. */
  code: string;
  count: number;
  /** Fraction of the blocked consults in the window, 0..1. */
  share: number;
  lastSeen: string;
  example: string;
  /** Repos this cause was seen in, most-affected first. */
  repos: string[];
}

export interface BlockerReport {
  totalConsults: number;
  blocked: number;
  roots: number;
  groups: BlockerGroup[];
}

/**
 * Codes that describe how a send died rather than why. Counting these whole
 * reports "the catch-all is biggest" and names nothing to fix - measured, one
 * of them held 165 of 267 blockers - so their message decides the group.
 */
const CATCH_ALL_CODES = new Set(["browser_send_failed", "consult_failed", "unknown_error"]);

/**
 * The part of a message that identifies the failure, with the varying parts
 * removed: the same picker failure is written once with "Pro" and once with a
 * model name, and those are one cause, not two.
 */
export function blockerCause(message: string): string {
  const firstSentence = /^(.*?)(?:\.\s|\.$|$)/.exec(message.trim())?.[1] ?? message.trim();
  return firstSentence
    .replace(/"[^"]*"/g, '"..."')
    .replace(/\d+/g, "N")
    .replace(/\s+/g, " ")
    .trim();
}

function groupKey(code: string, message: string): string {
  if (!CATCH_ALL_CODES.has(code)) return code;
  const cause = blockerCause(message);
  return cause ? `${code}: ${cause}` : code;
}

export function buildBlockerReport(input: {
  consults: readonly BlockerConsult[];
  roots: number;
  /** ISO instant; consults created before it are ignored. */
  since?: string;
  /** How many causes to list. The totals always count every one. */
  limit?: number;
}): BlockerReport {
  const cutoff = input.since ? Date.parse(input.since) : undefined;
  const inWindow = input.consults.filter((c) => {
    if (cutoff === undefined) return true;
    if (!c.createdAt) return false;
    const at = Date.parse(c.createdAt);
    return Number.isFinite(at) && at >= cutoff;
  });

  const groups = new Map<string, { count: number; lastSeen: string; example: string; repos: Map<string, number> }>();
  let blocked = 0;
  for (const consult of inWindow) {
    if (!consult.blocker) continue;
    blocked += 1;
    const key = groupKey(consult.blocker.code, consult.blocker.message);
    const at = consult.createdAt ?? "";
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      // The example belongs to the record the row dates itself by. Keeping the
      // first one seen printed a cause's oldest wording next to its newest
      // timestamp: a group holding both `has no "Pro" step` and a pre-fix
      // `has no "<a model>" step` showed the fixed one as what is failing now.
      if (at > existing.lastSeen) {
        existing.lastSeen = at;
        existing.example = consult.blocker.message;
      }
      existing.repos.set(consult.repo, (existing.repos.get(consult.repo) ?? 0) + 1);
    } else {
      groups.set(key, {
        count: 1,
        lastSeen: at,
        example: consult.blocker.message,
        repos: new Map([[consult.repo, 1]])
      });
    }
  }

  const ranked = [...groups.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .slice(0, input.limit ?? Number.POSITIVE_INFINITY)
    .map(([code, g]) => ({
      code,
      count: g.count,
      share: blocked > 0 ? g.count / blocked : 0,
      lastSeen: g.lastSeen,
      example: g.example,
      repos: [...g.repos.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([repo]) => repo)
    }));

  return { totalConsults: inWindow.length, blocked, roots: input.roots, groups: ranked };
}
