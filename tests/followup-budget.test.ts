import { createHash } from "node:crypto";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  FollowupApprovalRequired,
  reserveFollowup,
  resolveMaxAutoFollowups
} from "../src/followup-budget.js";
import { setBridgeStoreTestHooks, BridgeStore } from "../src/store.js";

afterEach(() => {
  setBridgeStoreTestHooks({});
});

describe("follow-up budget configuration", () => {
  it("defaults to five and accepts strict nonnegative digits through 1000", () => {
    expect(resolveMaxAutoFollowups(undefined)).toBe(5);
    expect(resolveMaxAutoFollowups("0")).toBe(0);
    expect(resolveMaxAutoFollowups("005")).toBe(5);
    expect(resolveMaxAutoFollowups("1000")).toBe(1000);
  });

  it.each(["", "-1", "+1", "1.0", "1e2", " 1", "1 ", "1001", "9007199254740992"])(
    "rejects invalid PRODEX_MAX_AUTO_FOLLOWUPS value %j",
    (value) => {
      expect(() => resolveMaxAutoFollowups(value)).toThrow(/PRODEX_MAX_AUTO_FOLLOWUPS.*0.*1000/i);
    }
  );
});

describe("durable follow-up reservations", () => {
  it("shares one conversation budget across URL forms and repeated old parent tasks", async () => {
    const store = await createStore();
    const conversationId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

    await expect(
      reserveFollowup(store, {
        thread: `https://chatgpt.com/c/${conversationId}?model=gpt-5`,
        taskId: "task-old",
        limit: 5
      })
    ).resolves.toEqual({ limit: 5, used: 1, remaining: 4 });
    await expect(
      reserveFollowup(store, {
        thread: `https://chatgpt.com/g/g-p-project/c/${conversationId}`,
        taskId: "task-new",
        limit: 5
      })
    ).resolves.toEqual({ limit: 5, used: 2, remaining: 3 });
    await expect(
      reserveFollowup(store, {
        thread: `https://chatgpt.com/c/${conversationId}`,
        taskId: "task-old",
        limit: 5
      })
    ).resolves.toEqual({ limit: 5, used: 3, remaining: 2 });

    const receipts = await store.listReceipts({ kind: "consult_followup_reserved" });
    const conversationKey = createHash("sha256").update(conversationId.toLowerCase(), "utf8").digest("hex");
    expect(receipts.every((receipt) => receipt.metadata.conversation_key === conversationKey)).toBe(true);
    expect(receipts.every((receipt) => receipt.metadata.conversation_id === undefined)).toBe(true);
    expect(receipts.every((receipt) => !receipt.summary.includes(conversationId))).toBe(true);
    expect(
      receipts
        .map((receipt) => receipt.metadata.sequence)
        .sort((left, right) => Number(left) - Number(right))
    ).toEqual([1, 2, 3]);
  });

  it("isolates different conversations within the same bridge root", async () => {
    const store = await createStore();

    await expect(reserve(store, "conversation-one", "task-a", 2)).resolves.toEqual({
      limit: 2,
      used: 1,
      remaining: 1
    });
    await expect(reserve(store, "conversation-two", "task-b", 2)).resolves.toEqual({
      limit: 2,
      used: 1,
      remaining: 1
    });
  });

  it("serializes concurrent reservations from separate store instances", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-followup-budget-"));
    const firstStore = new BridgeStore(root, { registerRoot: false });
    const secondStore = new BridgeStore(root, { registerRoot: false });

    const outcomes = await Promise.all([
      reserve(firstStore, "shared-conversation", "task-first", 5),
      reserve(secondStore, "shared-conversation", "task-second", 5)
    ]);

    expect(outcomes.map((budget) => budget.used).sort((left, right) => left - right)).toEqual([1, 2]);
    await expect(
      reserve(new BridgeStore(root, { registerRoot: false }), "shared-conversation", "task-third", 5)
    ).resolves.toEqual({ limit: 5, used: 3, remaining: 2 });
  });

  it("allows exactly one of two concurrent reservations at a limit of one", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "prodex-followup-budget-"));
    const outcomes = await Promise.allSettled([
      reserve(new BridgeStore(root, { registerRoot: false }), "limit-one", "task-first", 1),
      reserve(new BridgeStore(root, { registerRoot: false }), "limit-one", "task-second", 1)
    ]);

    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ reason: expect.any(FollowupApprovalRequired) });
    expect(
      await new BridgeStore(root, { registerRoot: false }).listReceipts({ kind: "consult_followup_reserved" })
    ).toHaveLength(1);
  });

  it("throws without writing when the automatic budget is exhausted", async () => {
    const store = await createStore();
    await reserve(store, "exhausted-conversation", "task-one", 2);
    await reserve(store, "exhausted-conversation", "task-two", 2);

    const error = await reserve(store, "exhausted-conversation", "task-old", 2).catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(FollowupApprovalRequired);
    expect((error as FollowupApprovalRequired).budget).toEqual({ limit: 2, used: 2, remaining: 0 });
    expect(await store.listReceipts({ kind: "consult_followup_reserved" })).toHaveLength(2);
  });

  it("requires approval before every automatic follow-up when the limit is zero", async () => {
    const store = await createStore();

    await expect(reserve(store, "zero-conversation", "task-auto", 0)).rejects.toMatchObject({
      budget: { limit: 0, used: 0, remaining: 0 }
    });
    await expect(
      reserveFollowup(store, {
        thread: threadUrl("zero-conversation"),
        taskId: "task-approved",
        userApproved: true,
        limit: 0
      })
    ).resolves.toEqual({ limit: 0, used: 0, remaining: 0 });
    await expect(reserve(store, "zero-conversation", "task-auto-again", 0)).rejects.toBeInstanceOf(
      FollowupApprovalRequired
    );
    expect(await store.listReceipts({ kind: "consult_followup_reserved" })).toHaveLength(1);
  });

  it("records approval as a renewal without consuming an automatic attempt", async () => {
    const store = await createStore();
    await reserve(store, "renewed-conversation", "task-one", 3);
    await reserve(store, "renewed-conversation", "task-two", 3);

    await expect(
      reserveFollowup(store, {
        thread: threadUrl("renewed-conversation"),
        taskId: "task-approved",
        userApproved: true,
        limit: 3
      })
    ).resolves.toEqual({ limit: 3, used: 0, remaining: 3 });
    await expect(reserve(store, "renewed-conversation", "task-three", 3)).resolves.toEqual({
      limit: 3,
      used: 1,
      remaining: 2
    });
  });

  it("fails closed on an unsigned forged reservation", async () => {
    const store = await createStore();
    const receiptId = "receipt_20990101_000000_forged-followup";
    await writeFile(
      path.join(store.root, ".bridge", "receipts", `${receiptId}.json`),
      `${JSON.stringify(
        {
          schema_version: 1,
          id: receiptId,
          kind: "consult_followup_reserved",
          task_id: "task-forged",
          summary: "Forged follow-up reservation",
          metadata: {
            conversation_key: conversationKey("forged-conversation"),
            sequence: 1,
            user_approved: false,
            limit: 5,
            used: 1,
            remaining: 4
          },
          created_at: "2099-01-01T00:00:00.000Z"
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    await expect(reserve(store, "forged-conversation", "task-real", 5)).rejects.toThrow(/integrity|trusted/i);
  });

  it("fails closed on a trusted reservation with suspicious metadata", async () => {
    const store = await createStore();
    await store.writeReceipt({
      kind: "consult_followup_reserved",
      task_id: "task-malformed",
      summary: "Malformed follow-up reservation",
      metadata: {
        conversation_key: conversationKey("malformed-conversation"),
        sequence: 2,
        user_approved: false,
        limit: 5,
        used: 1,
        remaining: 4
      }
    });

    await expect(reserve(store, "malformed-conversation", "task-real", 5)).rejects.toThrow(
      /follow-up reservation.*sequence|sequence.*follow-up reservation/i
    );
  });

  it("fails closed on a corrupt reservation record", async () => {
    const store = await createStore();
    const receiptId = "receipt_20990101_000000_corrupt-followup";
    await writeFile(path.join(store.root, ".bridge", "receipts", `${receiptId}.json`), "{not-json\n", "utf8");

    await expect(reserve(store, "corrupt-conversation", "task-real", 5)).rejects.toThrow(/receipt record is corrupt/i);
  });

  it("retains prior usage when writing the next reservation fails", async () => {
    const store = await createStore();
    await reserve(store, "write-failure-conversation", "task-one", 5);
    setBridgeStoreTestHooks({
      beforeRecordRename: async (kind) => {
        if (kind === "receipts") throw new Error("forced follow-up receipt failure");
      }
    });

    await expect(reserve(store, "write-failure-conversation", "task-two", 5)).rejects.toThrow(
      /forced follow-up receipt failure/
    );
    setBridgeStoreTestHooks({});

    await expect(reserve(store, "write-failure-conversation", "task-three", 5)).resolves.toEqual({
      limit: 5,
      used: 2,
      remaining: 3
    });
  });

  it("rejects invalid direct limits before reserving", async () => {
    const store = await createStore();

    for (const limit of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1001]) {
      await expect(reserve(store, "invalid-limit", "task-invalid", limit)).rejects.toThrow(/limit.*0.*1000/i);
    }
    expect(await receiptFiles(store)).toEqual([]);
  });

  it.each([
    "https://example.com/c/foreign-conversation",
    "http://chatgpt.com/c/insecure-conversation",
    "https://user@example.com@chatgpt.com/c/credentialed-conversation",
    "https://chatgpt.com/not-c/a-conversation"
  ])("rejects an invalid ChatGPT conversation URL %s", async (thread) => {
    const store = await createStore();

    await expect(
      reserveFollowup(store, { thread, taskId: "task-invalid-thread", limit: 5 })
    ).rejects.toThrow(/ChatGPT conversation/i);
    expect(await receiptFiles(store)).toEqual([]);
  });
});

async function createStore(): Promise<BridgeStore> {
  const root = await mkdtemp(path.join(tmpdir(), "prodex-followup-budget-"));
  const store = new BridgeStore(root, { registerRoot: false });
  await store.ensure();
  return store;
}

function reserve(store: BridgeStore, conversationId: string, taskId: string, limit: number) {
  return reserveFollowup(store, { thread: threadUrl(conversationId), taskId, limit });
}

function threadUrl(conversationId: string): string {
  return `https://chatgpt.com/c/${conversationId}`;
}

function conversationKey(conversationId: string): string {
  return createHash("sha256").update(conversationId.toLowerCase(), "utf8").digest("hex");
}

async function receiptFiles(store: BridgeStore): Promise<string[]> {
  return (await readdir(path.join(store.root, ".bridge", "receipts"))).filter((entry) => entry.endsWith(".json"));
}
