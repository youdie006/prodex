import { describe, expect, it } from "vitest";

import { resolveTranscriptCitations } from "../src/chatgpt-browser.js";

const S = "\uE200"; // marker start
const SEP = "\uE202"; // field separator
const E = "\uE201"; // marker end

// Caught by comparing a saved answer against the thread it came from. A
// web-search reply ended, in the receipt, with a dangling "Source:" - and the
// transcript showed why: the source line was
//   Source: <S>url<SEP>Timeanddate.com — World Clock<SEP>turn0search0<E>
// a marker whose reference carried type "url" and an EMPTY items array. The
// resolver builds its replacement only out of items, so an empty list became an
// empty string and took the visible title out of the answer with it. The reader
// lost a sentence and nothing warned.
describe("a citation marker with nothing to link to", () => {
  it("keeps the words it was wrapping", () => {
    const text = `Source: ${S}url${SEP}Timeanddate.com — World Clock${SEP}turn0search0${E}`;
    const resolved = resolveTranscriptCitations(text, [
      { matched_text: `${S}url${SEP}Timeanddate.com — World Clock${SEP}turn0search0${E}`, items: [] }
    ]);
    expect(resolved).toContain("Timeanddate.com — World Clock");
    expect(resolved).not.toMatch(/[-]/);
  });

  it("keeps them even when no reference mentions the marker at all", () => {
    const text = `See ${S}url${SEP}The Personal World Clock${SEP}turn0search1${E} for the time.`;
    const resolved = resolveTranscriptCitations(text, []);
    expect(resolved).toContain("The Personal World Clock");
    expect(resolved).not.toMatch(/[-]/);
  });

  it("still disappears when it wrapped no words", () => {
    // `<S>cite<SEP>turn0search0<E>` is an anchor, not prose: there is nothing a
    // reader would miss, so dropping it is right.
    const resolved = resolveTranscriptCitations(`Lisbon.${S}cite${SEP}turn0search0${E}`, []);
    expect(resolved.trim()).toBe("Lisbon.");
  });

  it("still prefers a real link when the reference has one", () => {
    const marker = `${S}cite${SEP}turn0search0${E}`;
    const resolved = resolveTranscriptCitations(`Lisbon.${marker}`, [
      { matched_text: marker, items: [{ title: "VisitPortugal", url: "https://www.visitportugal.com/" }] }
    ]);
    expect(resolved).toContain("[VisitPortugal](https://www.visitportugal.com/)");
  });
});
