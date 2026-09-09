import { describe, expect, it } from "vitest";

import { composerBindingTarget, composerProjectBinding } from "../src/chatgpt-browser.js";
import { browserSendBlockerFromError } from "../src/cli-pro.js";

// prodex used to rebind the composer to the project it had just entered by
// hard-reloading the project home. Measured live on two different projects:
// every hard load of a project home - Page.reload and location.assign alike -
// comes back as ChatGPT's error page ("Try again", no composer), while the
// sidebar SPA navigation lands on a working page in under two seconds. The
// rebind therefore could not succeed, and every project send that navigated
// died on it.
//
// The same measurement found what the reload was reaching for: the composer's
// own placeholder names the project it will post into ("New chat in <name>"),
// and it followed the SPA navigation across project to project and back. So
// the binding can be READ instead of forced.
describe("reading which project the composer will post into", () => {
  it("accepts a composer that names the project we asked for", () => {
    expect(composerProjectBinding({ placeholder: "New chat in Notes", projectName: "Notes" })).toBe("bound");
  });

  it("does not care about case, because the caller types the name", () => {
    expect(composerProjectBinding({ placeholder: "New chat in Notes", projectName: "notes" })).toBe("bound");
  });

  it("reads the Korean phrasing too", () => {
    expect(composerProjectBinding({ placeholder: "Notes에서 새 채팅", projectName: "Notes" })).toBe("bound");
  });

  it("refuses a composer left behind on another project", () => {
    expect(composerProjectBinding({ placeholder: "New chat in Ledger", projectName: "Notes" })).toBe("elsewhere");
  });

  // The exact failure the reload existed to prevent: the URL is on the
  // requested project while the composer still belongs to where the tab came
  // from, so the prompt posts into the wrong place with nothing to show for it.
  it("refuses the composer of a plain new chat, which belongs to no project", () => {
    expect(composerProjectBinding({ placeholder: "Ask ChatGPT", projectName: "Notes" })).toBe("elsewhere");
  });

  // Sidebar rows are matched by exact name, so "Notes" and "Notes Archive" are
  // two projects; a composer naming one must not pass for the other.
  it("tells a project from another whose name starts the same way", () => {
    expect(composerProjectBinding({ placeholder: "New chat in Notes Archive", projectName: "Notes" })).toBe("elsewhere");
    expect(composerProjectBinding({ placeholder: "New chat in Notes", projectName: "Notes Archive" })).toBe("elsewhere");
  });

  // A placeholder that merely contains the name is not evidence the composer
  // belongs to that project: "New chat in Notes Archive" contains "Notes" too,
  // and so does a phrasing that says the opposite in a locale we cannot read.
  // The caller refuses on "unknown", which costs a retry; accepting the
  // substring costs a prompt posted into another project.
  it("has no answer for a phrasing it cannot parse, even one naming the project", () => {
    expect(composerProjectBinding({ placeholder: "Nueva conversacion en Notes", projectName: "Notes" })).toBe("unknown");
  });

  // ChatGPT renders the placeholder, not prodex, so the run of whitespace in
  // the template is the page's to vary. The project NAME is still compared as
  // it was typed.
  it("reads the template through however much whitespace it carries", () => {
    expect(composerProjectBinding({ placeholder: "New  chat   in Notes", projectName: "Notes" })).toBe("bound");
  });

  it("has no answer when the composer carries no placeholder at all", () => {
    expect(composerProjectBinding({ placeholder: "", projectName: "Notes" })).toBe("unknown");
    expect(composerProjectBinding({ projectName: "Notes" })).toBe("unknown");
  });
});

// The gate above only protects a send that reaches it. A send that CREATES its
// project used to walk around it: the project step returned as soon as the new
// project existed, and the re-read before typing asked only about a pinned
// name, which such a send does not have. So the one send that had never seen
// its destination before was the one nothing checked, and its receipt would
// carry the new project's name either way.
describe("which project a send has to bind to", () => {
  it("checks a project the send just created, not only one it navigated to", () => {
    expect(composerBindingTarget({ projectNew: "Notes" })).toBe("Notes");
  });

  it("checks the project a send pins by name", () => {
    expect(composerBindingTarget({ project: "Notes" })).toBe("Notes");
  });

  it("has nothing to check when the send pins no project", () => {
    expect(composerBindingTarget({})).toBeUndefined();
  });
});

// Refusing to send is the point: a prompt that posts into another project is
// recorded against the project the caller asked for, and the answer ends up
// where nobody looks for it.
describe("what an unbound composer tells the caller", () => {
  const blocker = browserSendBlockerFromError(
    new Error(
      'ChatGPT composer did not bind to project "<project>": after entering it, the composer still offers a chat that belongs somewhere else, so nothing was sent.'
    )
  );

  it("names the binding rather than the browser", () => {
    expect(blocker.code).toBe("project_not_bound");
  });

  it("is worth retrying, because the next navigation usually binds", () => {
    expect(blocker.retryable).toBe(true);
  });

  it("says that nothing was sent, which is the part worth knowing", () => {
    expect(blocker.next_step).toMatch(/nothing was sent/i);
  });

  // Three refusals share the phrase the classifier keys on: the composer was
  // read as another project's, its placeholder could not be read at all, and
  // it stopped reading as this project's between entering it and typing.
  // Each has to reach the same code, or the one that does not looks like a
  // browser fault the caller should work around.
  it("classifies every shape of the refusal the same way", () => {
    const messages = [
      'ChatGPT composer did not bind to project "<project>": after entering it, the composer\'s placeholder could not be read, so where the prompt would land is unknown, so nothing was sent.',
      'ChatGPT composer did not bind to project "<project>": after entering it, the composer still offers a chat that belongs somewhere else, so nothing was sent. Recovery failed: the sidebar click did not reach a project page',
      'ChatGPT composer did not bind to project "<project>": it read as this project\'s after entering it and no longer does, so nothing was sent.'
    ];
    for (const message of messages) {
      const classified = browserSendBlockerFromError(new Error(message));
      expect(classified.code).toBe("project_not_bound");
      expect(classified.retryable).toBe(true);
      expect(classified.next_step).toMatch(/nothing was sent/i);
    }
  });
});
