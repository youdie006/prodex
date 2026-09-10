import { describe, expect, it } from "vitest";

import { chatGptProjectIdFromUrl, destinationVerification } from "../src/chatgpt-browser.js";

// The receipt recorded the project the caller ASKED for, which is intent, not
// evidence: a prompt that landed somewhere else was filed under the name of the
// place it never reached. The answered thread's URL says which project it
// really belongs to, and the project step knows the id it bound to.
describe("reading which project a ChatGPT URL belongs to", () => {
  // Measured within a single send: the same project rendered both ways, so
  // comparing the slugs whole would have called them two projects.
  it("takes the id through both ways the same project renders", () => {
    const withoutName = "https://chatgpt.com/g/g-p-6aa23c9208608191a9b5403be2098710/project";
    const withName = "https://chatgpt.com/g/g-p-6aa23c9208608191a9b5403be2098710-a-project/c/6aa23c98-3704-83e8";
    expect(chatGptProjectIdFromUrl(withoutName)).toBe("6aa23c9208608191a9b5403be2098710");
    expect(chatGptProjectIdFromUrl(withName)).toBe(chatGptProjectIdFromUrl(withoutName));
  });

  it("has no id for a chat that belongs to no project", () => {
    expect(chatGptProjectIdFromUrl("https://chatgpt.com/c/6aa23c98-3704-83e8")).toBeUndefined();
    expect(chatGptProjectIdFromUrl("https://chatgpt.com/")).toBeUndefined();
    expect(chatGptProjectIdFromUrl(undefined)).toBeUndefined();
  });
});

describe("checking where the answer actually landed", () => {
  const boundProjectId = "6aa23c9208608191a9b5403be2098710";
  const inProject = `https://chatgpt.com/g/g-p-${boundProjectId}-a-project/c/6aa23c98-3704-83e8`;

  it("confirms a thread that belongs to the project the send entered", () => {
    expect(destinationVerification({ requestedProject: true, boundProjectId, answeredUrl: inProject })).toEqual({
      destination: "project",
      verified: true
    });
  });

  it("says so when the answer is in a different project than the one entered", () => {
    const result = destinationVerification({
      requestedProject: true,
      boundProjectId,
      answeredUrl: "https://chatgpt.com/g/g-p-1111111111111111111111111111111f/c/6aa23c98-3704-83e8"
    });
    expect(result.verified).toBe(false);
    expect(result.warning).toMatch(/different project/i);
  });

  // Naming the project it landed in would put another project's name in a
  // persisted record; the thread URL in the receipt is the way to go look.
  it("does not name the project it landed in", () => {
    const result = destinationVerification({
      requestedProject: true,
      boundProjectId,
      answeredUrl: "https://chatgpt.com/g/g-p-1111111111111111111111111111111f-somewhere-else/c/6aa23c98"
    });
    expect(result.warning).not.toMatch(/somewhere-else/);
  });

  it("still catches a project send that answered in a root chat", () => {
    const result = destinationVerification({
      requestedProject: true,
      boundProjectId,
      answeredUrl: "https://chatgpt.com/c/6aa23c98-3704-83e8"
    });
    expect(result.destination).toBe("root");
    expect(result.verified).toBe(false);
    expect(result.warning).toMatch(/OUTSIDE the project/);
  });

  // The root-landing warning predates the id comparison and caught this in the
  // field. It needs no id: a project send that answered outside every project
  // is wrong on its own evidence.
  it("warns about a root landing even when there is no id to compare", () => {
    const result = destinationVerification({
      requestedProject: true,
      answeredUrl: "https://chatgpt.com/c/6aa23c98-3704-83e8"
    });
    expect(result.destination).toBe("root");
    expect(result.warning).toMatch(/OUTSIDE the project/);
  });

  // An unverified landing is its own answer. Recording "verified" for a send
  // nothing checked is how a receipt certifies a misdelivery.
  it("refuses to certify a landing it could not check", () => {
    expect(destinationVerification({ requestedProject: true, answeredUrl: inProject }).verified).toBe(false);
    expect(destinationVerification({ requestedProject: true, boundProjectId }).verified).toBe(false);
  });

  it("has nothing to verify when no project was asked for", () => {
    expect(destinationVerification({ requestedProject: false, answeredUrl: "https://chatgpt.com/c/6aa2" })).toEqual({
      destination: "root"
    });
  });
});
