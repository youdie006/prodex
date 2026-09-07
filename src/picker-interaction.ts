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
