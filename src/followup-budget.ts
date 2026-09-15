import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";

import { isChatGptConversationUrl } from "./continue-thread.js";
import { withCrossProcessFileLock } from "./safe-file.js";
import type { Receipt } from "./schema.js";
import { BridgeStore } from "./store.js";

const DEFAULT_MAX_AUTO_FOLLOWUPS = 5;
const MAX_AUTO_FOLLOWUPS = 1000;
const FOLLOWUP_BUDGET_LOCK_WAIT_MS = 30_000;

const FollowupReservationMetadataSchema = z.object({
  conversation_key: z.string().regex(/^[a-f0-9]{64}$/),
  sequence: z.number().int().positive().safe(),
  user_approved: z.boolean(),
  limit: z.number().int().min(0).max(MAX_AUTO_FOLLOWUPS).safe(),
  used: z.number().int().min(0).max(MAX_AUTO_FOLLOWUPS).safe(),
  remaining: z.number().int().min(0).max(MAX_AUTO_FOLLOWUPS).safe()
});

type FollowupReservationMetadata = z.infer<typeof FollowupReservationMetadataSchema>;

export interface FollowupBudget {
  limit: number;
  used: number;
  remaining: number;
}

export class FollowupApprovalRequired extends Error {
  readonly budget: FollowupBudget;

  constructor(budget: FollowupBudget) {
    super("Automatic follow-up budget exhausted; explicit user approval is required");
    this.name = "FollowupApprovalRequired";
    this.budget = budget;
  }
}

export function resolveMaxAutoFollowups(
  envValue: string | undefined = process.env.PRODEX_MAX_AUTO_FOLLOWUPS
): number {
  if (envValue === undefined) return DEFAULT_MAX_AUTO_FOLLOWUPS;
  if (!/^\d+$/.test(envValue)) throw invalidMaxAutoFollowupsError();

  const value = Number(envValue);
  if (!Number.isSafeInteger(value) || value > MAX_AUTO_FOLLOWUPS) {
    throw invalidMaxAutoFollowupsError();
  }
  return value;
}

export async function reserveFollowup(
  store: BridgeStore,
  input: { thread: string; taskId: string; userApproved?: boolean; limit: number }
): Promise<FollowupBudget> {
  assertFollowupLimit(input.limit);
  const conversationKey = conversationKeyFromThread(input.thread);
  await store.ensure();

  const lockPath = path.join(store.root, ".bridge", "followup-budget.lock");
  return withCrossProcessFileLock(
    lockPath,
    {
      waitMs: FOLLOWUP_BUDGET_LOCK_WAIT_MS,
      retryMs: 25,
      privateParent: true,
      busyError: (holder) =>
        new Error(`Another follow-up reservation is in progress (pid ${holder.pid ?? "unknown"})`),
      unavailableError: () =>
        new Error(
          "The follow-up budget lock could not be recovered. Stop all prodex processes before removing the lock and its matching .reap claim, then retry."
        )
    },
    async () => reserveFollowupUnderLock(store, { ...input, conversationKey })
  );
}

async function reserveFollowupUnderLock(
  store: BridgeStore,
  input: {
    conversationKey: string;
    taskId: string;
    userApproved?: boolean;
    limit: number;
  }
): Promise<FollowupBudget> {
  const reservations = await readTrustedReservations(store);
  const conversationReservations = reservations
    .filter((reservation) => reservation.metadata.conversation_key === input.conversationKey)
    .sort((left, right) => left.metadata.sequence - right.metadata.sequence);
  const previous = validateConversationLedger(conversationReservations);

  if (input.userApproved !== true && previous.used >= input.limit) {
    throw new FollowupApprovalRequired({
      limit: input.limit,
      used: previous.used,
      remaining: 0
    });
  }

  const budget: FollowupBudget = input.userApproved === true
    ? { limit: input.limit, used: 0, remaining: input.limit }
    : {
        limit: input.limit,
        used: previous.used + 1,
        remaining: input.limit - (previous.used + 1)
      };
  const sequence = previous.sequence + 1;

  await store.writeReceipt({
    kind: "consult_followup_reserved",
    task_id: input.taskId,
    summary:
      input.userApproved === true
        ? "Renewed automatic follow-up budget"
        : `Reserved automatic follow-up ${budget.used}`,
    metadata: {
      conversation_key: input.conversationKey,
      sequence,
      user_approved: input.userApproved === true,
      ...budget
    }
  });

  return budget;
}

async function readTrustedReservations(
  store: BridgeStore
): Promise<Array<{ receipt: Receipt; metadata: FollowupReservationMetadata }>> {
  const listed = await store.listReceipts({ kind: "consult_followup_reserved" });
  const reservations: Array<{ receipt: Receipt; metadata: FollowupReservationMetadata }> = [];

  for (const listedReceipt of listed) {
    const receipt = await store.getTrustedReceipt(listedReceipt.id);
    if (!receipt.task_id?.trim()) {
      throw suspiciousReservationError(receipt.id, "task_id is missing");
    }
    const parsed = FollowupReservationMetadataSchema.safeParse(receipt.metadata);
    if (!parsed.success) {
      throw suspiciousReservationError(receipt.id, "metadata is invalid");
    }
    reservations.push({ receipt, metadata: parsed.data });
  }

  return reservations;
}

function validateConversationLedger(
  reservations: Array<{ receipt: Receipt; metadata: FollowupReservationMetadata }>
): { sequence: number; used: number } {
  let used = 0;

  for (let index = 0; index < reservations.length; index += 1) {
    const { receipt, metadata } = reservations[index]!;
    const expectedSequence = index + 1;
    if (metadata.sequence !== expectedSequence) {
      throw suspiciousReservationError(
        receipt.id,
        `sequence ${metadata.sequence} does not match expected sequence ${expectedSequence}`
      );
    }

    const expectedUsed = metadata.user_approved ? 0 : used + 1;
    if (metadata.used !== expectedUsed) {
      throw suspiciousReservationError(receipt.id, `used is ${metadata.used}, expected ${expectedUsed}`);
    }
    if (!metadata.user_approved && metadata.used > metadata.limit) {
      throw suspiciousReservationError(receipt.id, "an automatic reservation exceeds its recorded limit");
    }
    if (metadata.remaining !== metadata.limit - metadata.used) {
      throw suspiciousReservationError(receipt.id, "remaining does not match limit minus used");
    }
    used = metadata.used;
  }

  return { sequence: reservations.length, used };
}

function conversationKeyFromThread(thread: string): string {
  if (!isChatGptConversationUrl(thread)) {
    throw new Error("Follow-up thread must identify a valid ChatGPT conversation");
  }

  let url: URL;
  try {
    url = new URL(thread);
  } catch {
    throw new Error("Follow-up thread must identify a valid ChatGPT conversation");
  }

  if (
    url.protocol !== "https:" ||
    url.hostname !== "chatgpt.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error("Follow-up thread must identify a valid ChatGPT conversation");
  }

  const match = /^\/(?:c|g\/[^/]+\/c)\/([A-Za-z0-9_-]{1,256})\/?$/.exec(url.pathname);
  if (!match) throw new Error("Follow-up thread must identify a valid ChatGPT conversation");
  return createHash("sha256").update(match[1]!.toLowerCase(), "utf8").digest("hex");
}

function assertFollowupLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_AUTO_FOLLOWUPS) {
    throw new Error(`Follow-up limit must be a safe integer from 0 through ${MAX_AUTO_FOLLOWUPS}`);
  }
}

function invalidMaxAutoFollowupsError(): Error {
  return new Error(`PRODEX_MAX_AUTO_FOLLOWUPS must contain only digits and be from 0 through ${MAX_AUTO_FOLLOWUPS}`);
}

function suspiciousReservationError(receiptId: string, reason: string): Error {
  return new Error(`Follow-up reservation ${receiptId} is corrupt or suspicious: ${reason}`);
}
