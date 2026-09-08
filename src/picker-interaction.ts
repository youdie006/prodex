/** Pure decision helpers for ChatGPT's composer picker, kept out of the page. */

export interface PickerItemSnapshot {
  role: string | null;
  text: string;
  checked: boolean;
  containsSlider: boolean;
}

export interface PowerSliderSelectionSnapshot {
  sliderValueText?: string | null;
  items: readonly PickerItemSnapshot[];
}

/** Read model and effort from both the current mixed-control picker and its prior labeled-row form. */
export function readPowerSliderSelection(snapshot: PowerSliderSelectionSnapshot): { model: string | null; effort: string | null } {
  const items = snapshot.items.map((item) => ({
    ...item,
    lines: item.text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
  }));
  const powerLabels = new Set([
    "instant",
    "light",
    "즉시",
    "빠름",
    "fast",
    "medium",
    "중간",
    "보통",
    "high",
    "높음",
    "extra high",
    "extrahigh",
    "very high",
    "매우 높음",
    "매우높음",
    "pro",
    "프로"
  ]);
  const legacyModel = items.find((item) => item.lines[0] === "Model")?.lines[1] ?? null;
  const legacyEffort = items.find((item) => item.lines[0] === "Effort")?.lines[1] ?? null;
  const checkedModel = items.find((item) => item.role === "menuitemradio" && item.checked)?.lines[0] ?? null;
  // The slider stopped being an effort control: one slider now walks a ladder of
  // model-and-effort pairs, and a row above the track reads "<model>" then
  // "<effort>". Measured live, that pair sits in a SIBLING row - the row that
  // literally contains the slider carries no text - so the pair is found by its
  // shape rather than by ownership of the track. Reading the pair's first line
  // as the effort is what made the listing announce "Extra High" as a model.
  const pairRow = items.find(
    (item) =>
      item.role === "menuitem" && item.lines.length >= 2 && item.lines[0] !== "Model" && item.lines[0] !== "Effort"
  );
  const owner = items.find((item) => item.role === "menuitem" && item.containsSlider);
  const sliderOwnerModel = pairRow?.lines[0] ?? null;
  // A single-line row is the older form, where it carried only the step name.
  const sliderOwner = pairRow?.lines[1] ?? (owner && owner.lines.length === 1 ? owner.lines[0] : null) ?? null;
  const visiblePowerLabel =
    items.find((item) => item.role === "menuitem" && powerLabels.has((item.lines[0] ?? "").toLowerCase()))?.lines[0] ?? null;
  const accessibleCandidate = snapshot.sliderValueText?.trim() || null;
  const accessibleValue = accessibleCandidate && powerLabels.has(accessibleCandidate.toLowerCase()) ? accessibleCandidate : null;
  return {
    // The checked radio is "Default" - the recommended set - while the slider
    // decides the model a send actually uses, so the slider's row wins.
    model: legacyModel ?? sliderOwnerModel ?? checkedModel,
    effort: accessibleValue ?? legacyEffort ?? sliderOwner ?? visiblePowerLabel
  };
}

export interface MenuKeyboardStepInput {
  /** The element the menu currently has focus on, or null if focus escaped. */
  active: { role: string | null; label: string } | null;
  /** Acceptable labels for the row being looked for. */
  requested: readonly string[];
  /** How many ArrowDown presses have already been spent. */
  pressed: number;
  /** Refuse to press more than this, so a miss cannot become endless keys. */
  limit: number;
}

/**
 * Decide the next move when walking the composer picker's menu by keyboard.
 *
 * The model rows carry pointer-events: none and refuse focus(), so the menu's
 * own roving focus is the only way to reach them. Only a radio counts as the
 * target: the row above the slider repeats the model name as its first line,
 * and committing there selects nothing.
 */
export function menuKeyboardStep(input: MenuKeyboardStepInput): "select" | "down" | "exhausted" {
  const { active, requested, pressed, limit } = input;
  if (!active) return "exhausted";
  if (active.role === "menuitemradio") {
    const label = active.label.trim().toLowerCase();
    if (requested.some((candidate) => candidate.trim().toLowerCase() === label)) return "select";
  }
  return pressed < limit ? "down" : "exhausted";
}

/**
 * One move towards putting the power slider back where the walk found it.
 *
 * Driven by the position actually read rather than by a replayed count, so an
 * interrupted walk still converges instead of abandoning the setting wherever
 * it stopped.
 */
export function sliderRestoreStep(input: { current?: number; target?: number }): "left" | "right" | "done" {
  const { current, target } = input;
  if (!Number.isInteger(current) || !Number.isInteger(target)) return "done";
  if (current === target) return "done";
  return (current as number) > (target as number) ? "left" : "right";
}

/**
 * Decide whether the browser needs putting back on ChatGPT's Chat surface.
 *
 * Chat and Work have different model pickers - Work's has no Pro at all - so a
 * browser that has drifted onto Work silently drives the wrong one.
 */
export function chatSurfaceChoice(
  surfaces: readonly { label: string; checked: boolean }[]
): "already-chat" | "switch-to-chat" | "no-toggle" {
  const chat = surfaces.find((surface) => surface.label.trim().toLowerCase() === "chat");
  if (!chat) return "no-toggle";
  return chat.checked ? "already-chat" : "switch-to-chat";
}

/**
 * Which surface is live, using the visible toggle where there is one and the
 * value ChatGPT persists where there is not.
 *
 * The toggle is only rendered on the home screen, but threads and project pages
 * keep the surface that was chosen - so a send into a project can be driving
 * Work's picker with nothing on the page to say so.
 */
export function chatSurfaceState(input: {
  storedMode?: string;
  surfaces: readonly { label: string; checked: boolean }[];
}): "already-chat" | "switch-to-chat" | "unknown" {
  const fromToggle = chatSurfaceChoice(input.surfaces);
  if (fromToggle !== "no-toggle") return fromToggle;
  const stored = (input.storedMode ?? "").trim().replace(/^"|"$/g, "").toLowerCase();
  if (stored === "chat") return "already-chat";
  // Only a value that names Work is a reason to move. Anything else - "null",
  // a mode this code has never heard of - is not evidence, and acting on it
  // would rewrite the preference and reload the page on every send.
  if (stored === "work") return "switch-to-chat";
  return "unknown";
}

/** Steps that exist only on ChatGPT's Work surface, so asking for one means staying there. */
const WORK_ONLY_EFFORTS = new Set(["max", "ultra"]);

/**
 * Whether the requested effort only exists on the Work surface.
 *
 * Sends otherwise put the browser back on Chat, which would make these two
 * impossible to apply while still being offered by the help.
 */
export function effortNeedsWorkSurface(effort: string | undefined): boolean {
  return effort ? WORK_ONLY_EFFORTS.has(effort.trim().toLowerCase()) : false;
}

/**
 * How to answer a JavaScript dialog that appeared in the driven browser.
 *
 * A dialog halts the page's main thread, so every evaluate after it hangs -
 * and a client that had not enabled the Page domain beforehand cannot dismiss
 * it at all. Answering one is therefore about getting out of the way, not about
 * agreeing to whatever it asked: only beforeunload is accepted, because that is
 * the page questioning a navigation prodex itself requested.
 */
export function javascriptDialogResponse(type: string | undefined): { accept: boolean } {
  return { accept: type === "beforeunload" };
}

/**
 * A note that prodex answered a dialog in the driven browser.
 *
 * Answering one is a button pressed in someone's real session, and it is also
 * the likeliest explanation for a send that behaved strangely around it, so it
 * belongs in the receipt rather than in nobody's notes.
 */
export function answeredDialogWarning(types: readonly string[]): string | undefined {
  if (types.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const type of types) counts.set(type, (counts.get(type) ?? 0) + 1);
  const listed = [...counts]
    .map(([type, count]) => (count > 1 ? `${type} x${count}` : type))
    .join(", ");
  const accepted = types.some((type) => type === "beforeunload");
  const action = accepted
    ? "accepted the page's leave prompt and dismissed the rest"
    : "dismissed without agreeing to it";
  return (
    `dialog_answered: a JavaScript dialog appeared in the ChatGPT window during this send (${listed}) and prodex ${action}, ` +
    "because a dialog left open halts the page and nothing after it would have run."
  );
}

/**
 * The surface a picker listing was read from: the checked toggle where one is
 * drawn (the home screen), else the choice ChatGPT persists - which is what the
 * app itself reads on the pages that draw no toggle. Undefined when neither
 * says anything.
 */
export function surfaceFromProbe(
  probe: { surfaces?: { label: string; checked: boolean }[]; storedMode?: string } | undefined
): string | undefined {
  const checked = probe?.surfaces?.find((entry) => entry.checked)?.label;
  if (checked) return checked;
  const stored = (probe?.storedMode ?? "").trim().replace(/^"|"$/g, "").toLowerCase();
  if (stored === "chat") return "Chat";
  if (stored === "work") return "Work";
  return undefined;
}
