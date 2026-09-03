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
  const sliderOwner = items.find((item) => item.role === "menuitem" && item.containsSlider)?.lines[0] ?? null;
  const visiblePowerLabel =
    items.find((item) => item.role === "menuitem" && powerLabels.has((item.lines[0] ?? "").toLowerCase()))?.lines[0] ?? null;
  const accessibleCandidate = snapshot.sliderValueText?.trim() || null;
  const accessibleValue = accessibleCandidate && powerLabels.has(accessibleCandidate.toLowerCase()) ? accessibleCandidate : null;
  return {
    model: legacyModel ?? checkedModel,
    effort: accessibleValue ?? legacyEffort ?? sliderOwner ?? visiblePowerLabel
  };
}
