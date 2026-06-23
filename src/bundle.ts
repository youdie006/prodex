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
  text: string;
  created_at: string;
}

export async function buildDryRunBundle(root: string, input: DryRunBundleInput): Promise<DryRunBundle> {
  const sections: string[] = [
    "# gptprouse consult dry run",
    "",
    "This preview was not sent anywhere.",
    "",
    "## Prompt",
    "",
    input.prompt.trim()
  ];
  const files: BridgeFile[] = [];
  for (const file of input.files) {
    const content = await readRepoFile(root, file, { maxLines: 500 });
    files.push({ path: file, role: "context", bytes: Buffer.byteLength(content.content, "utf8") });
    sections.push("", `## File: ${file}`, "", "```text", content.content, "```");
  }
  return {
    schema_version: SCHEMA_VERSION,
    id: makeBridgeId("sess", `${randomUUID().slice(0, 8)}-${input.prompt}`),
    mode: "manual_copy",
    prompt: input.prompt,
    files,
    text: sections.join("\n"),
    created_at: nowIso()
  };
}
