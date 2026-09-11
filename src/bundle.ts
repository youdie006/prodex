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

/**
 * Whether a file prodex was asked to INLINE is text at all.
 *
 * `--file` puts a file's text into the prompt and `--attach` uploads the file
 * itself; pointing `--file` at a binary used to inline the bytes. Measured:
 * `--file` on an executable produced a prompt carrying an ELF header and NUL
 * bytes inside a text fence - 535 control bytes in a 798-byte preview - which
 * costs tokens, answers nothing, and sends control characters through the
 * composer and the prompt-identity check.
 *
 * A NUL byte is the classic test and the one that never false-positives on
 * real source; a high share of other control bytes catches the rest without
 * tripping on text that merely has tabs and newlines.
 */
export function looksLikeBinaryFileContent(content: string): boolean {
  if (content.includes("\u0000")) return true;
  const sample = content.slice(0, 4096);
  if (sample.length === 0) return false;
  let control = 0;
  for (const ch of sample) {
    const code = ch.codePointAt(0) ?? 0;
    // Tab, newline and carriage return are ordinary text.
    if (code === 9 || code === 10 || code === 13) continue;
    if (code < 32 || code === 0xfffd) control += 1;
  }
  return control / sample.length > 0.1;
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
    if (looksLikeBinaryFileContent(content.content)) {
      throw new Error(
        `--file ${file} is not a text file, and --file inlines a file's TEXT into the prompt. ` +
          `Upload it instead: --attach ${file}.`
      );
    }
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
