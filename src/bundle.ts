import { randomUUID } from "node:crypto";
import { makeBridgeId, nowIso, SCHEMA_VERSION, type BridgeFile } from "./schema.js";
import { readRepoFile } from "./repo.js";

export interface DryRunBundleInput {
  prompt: string;
  files: string[];
}

export interface DryRunBundle {
  schema_version: 1;
  id: string;
  mode: "manual_copy";
  prompt: string;
  files: BridgeFile[];
  /** Preview text for `pro ask`: explicitly labelled as not sent. */
  text: string;
  /**
   * What actually goes into the ChatGPT composer. This used to be `text`, so
   * every real send arrived headed "# prodex consult dry run / This preview was
   * not sent anywhere." - prodex told the model to disregard the very message
   * it was asking it to answer.
   */
  sendText: string;
  created_at: string;
}

export async function buildDryRunBundle(root: string, input: DryRunBundleInput): Promise<DryRunBundle> {
  const sections: string[] = [
    "# prodex consult dry run",
    "",
    "This preview was not sent anywhere.",
    "",
    "## Prompt",
    "",
    input.prompt.trim()
  ];
  const files: BridgeFile[] = [];
  // The prompt leads so the instruction is never buried under file dumps.
  const sendSections: string[] = [input.prompt.trim()];
  for (const file of input.files) {
    const content = await readRepoFile(root, file, { maxLines: 500 });
    files.push({ path: file, role: "context", bytes: Buffer.byteLength(content.content, "utf8") });
    const fileSection = ["", `## File: ${file}`, "", "```text", content.content, "```"];
    sections.push(...fileSection);
    sendSections.push(...fileSection);
  }
  return {
    schema_version: SCHEMA_VERSION,
    id: makeBridgeId("sess", `${randomUUID().slice(0, 8)}-${input.prompt}`),
    mode: "manual_copy",
    prompt: input.prompt,
    files,
    text: sections.join("\n"),
    sendText: sendSections.join("\n"),
    created_at: nowIso()
  };
}
