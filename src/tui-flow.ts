/**
 * What the interactive picker asks, in the order it asks it.
 *
 * The first version asked for the prompt first and treated the kind of send as
 * an afterthought, which is backwards: whether this is an ordinary chat or a
 * ten-minute research run changes what you would type. Deciding the kind, then
 * the destination, then writing the prompt matches how the request is actually
 * formed - and it leaves the seconds spent choosing free for prodex to fetch
 * the project and conversation lists the destination step needs.
 */

export interface SendKind {
  id: string;
  label: string;
  hint?: string;
  /** Composer tools this kind turns on; empty for an ordinary chat. */
  tools: string[];
}

export const SEND_KINDS: SendKind[] = [
  { id: "chat", label: "Normal chat", hint: "ordinary Pro answer", tools: [] },
  { id: "deep-research", label: "Deep research", hint: "browsed report, runs about 10 minutes", tools: ["deep-research"] },
  { id: "web-search", label: "Web search", hint: "current facts, with sources", tools: ["web-search"] },
  { id: "create-image", label: "Create image", tools: ["create-image"] }
];

export type DestinationId = "continue" | "new" | "project" | "project-new" | "no-project";

export interface DestinationChoice {
  id: DestinationId;
  label: string;
  hint?: string;
}

/**
 * One screen for the whole destination question. Splitting "which project" from
 * "new thread or not" made the user answer twice for one decision, and left no
 * way at all to say "that conversation, the one from yesterday".
 */
export function destinationChoices(pinnedProject: string | undefined): DestinationChoice[] {
  return [
    { id: "continue", label: "Continue an existing conversation", hint: "pick from your recent chats" },
    {
      id: "new",
      label: "New chat",
      ...(pinnedProject ? { hint: `in your pinned project: ${pinnedProject}` } : { hint: "in the plain chat list" })
    },
    { id: "project", label: "New chat in an existing project", hint: "pick from your sidebar projects" },
    { id: "project-new", label: "New chat in a new project" },
    ...(pinnedProject ? [{ id: "no-project" as const, label: "New chat, ignoring the pinned project" }] : [])
  ];
}
