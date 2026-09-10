/**
 * Which conversation a follow-up consult belongs to.
 *
 * "Continue" used to mean "whatever thread the shared browser tab is showing",
 * which is not a conversation anyone named: another session, or a person
 * clicking around, moves it. Worse, a pinned project navigates AWAY from that
 * tab before every send, so on a machine with a default project every consult
 * started a fresh thread while the tool description promised the opposite
 * (measured: two consecutive sends into one project landed in two different
 * /c/ threads).
 *
 * prodex already writes down where each consult landed. That record - not the
 * tab - is what a follow-up should resolve against. Pure on purpose: the
 * reading lives in the command.
 */

/** One past consult, reduced to what resolution needs. */
export interface ConsultThreadRecord {
  taskId: string;
  thread?: string;
  status: string;
  createdAt?: string;
}

export interface ContinuationTarget {
  taskId: string;
  thread: string;
}

/**
 * The project name as it appears inside a thread URL.
 *
 * Measured: a project named "prodex-smoke-project" answers on
 * `/g/g-p-<id>-prodex-smoke-project/c/<id>`, and "Codex" on
 * `/g/g-p-<id>-codex/c/<id>` - the name lowercased, with runs of anything else
 * collapsed to a single dash.
 */
export function chatGptProjectSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Whether a recorded thread belongs to the project this send is for.
 *
 * A send with no project continues only a thread that belongs to no project,
 * so a follow-up meant for the general chat cannot walk into a project - and a
 * project's follow-up cannot land in another project's conversation.
 */
export function threadMatchesProject(threadUrl: string, project?: string): boolean {
  const projectSegment = /\/g\/(g-p-[^/?#]+)/.exec(threadUrl)?.[1];
  if (!project) return projectSegment === undefined;
  if (!projectSegment) return false;
  const slug = chatGptProjectSlug(project);
  if (!slug) return false;
  // The id comes first and the name follows it, so an exact suffix match keeps
  // "notes" from answering for "notes-archive".
  return projectSegment.toLowerCase().endsWith(`-${slug}`);
}

/**
 * The thread a follow-up should continue, or why it cannot be resolved.
 *
 * Naming a task wins over the search, because the caller who names one knows
 * which conversation they mean. Otherwise it is the most recent consult that
 * finished, in this project - fail-closed when there is none, since guessing
 * the conversation is the failure this exists to prevent.
 */
export function resolveContinuationThread(input: {
  consults: readonly ConsultThreadRecord[];
  project?: string;
  taskId?: string;
}): { target: ContinuationTarget } | { error: string } {
  const withThread = input.consults.filter((consult) => Boolean(consult.thread));
  if (input.taskId) {
    const named = withThread.find((consult) => consult.taskId === input.taskId);
    if (!named) {
      return {
        error:
          `No recorded consult thread for "${input.taskId}". List what is here with \`prodex pro list\`, ` +
          `or pass the thread itself with --target-url --confirm-target.`
      };
    }
    return { target: { taskId: named.taskId, thread: named.thread! } };
  }
  const candidates = withThread
    .filter((consult) => consult.status === "done")
    .filter((consult) => threadMatchesProject(consult.thread!, input.project))
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  const latest = candidates[0];
  if (!latest) {
    const where = input.project ? `project "${input.project}"` : "a chat outside any project";
    return {
      error:
        `No finished consult of this repo has a thread in ${where} to continue. ` +
        `Send once without --continue, or name a consult with --continue-task <task_id>.`
    };
  }
  return { target: { taskId: latest.taskId, thread: latest.thread! } };
}
