import { writeFileSync, readFileSync, mkdirSync, existsSync } from "fs";
import { join, basename } from "path";
import type { Utterance } from "../transcription/assemblyai.js";

export function buildTranscriptText(
  utterances: Utterance[],
  speakerMap: Map<string, string>,
): string {
  return utterances
    .map((u) => {
      const name = speakerMap.get(u.speaker) ?? `Speaker ${u.speaker}`;
      return `${name}: ${u.text}`;
    })
    .join("\n");
}

export function extractTitle(geminiOutput: string): string {
  if (geminiOutput.startsWith("# ")) {
    const firstNewline = geminiOutput.indexOf("\n");
    return geminiOutput.slice(2, firstNewline).trim();
  }
  return "Meeting Notes";
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

/**
 * Build and write the full note to the vault.
 * Returns the absolute path to the written file.
 */
export function writeNote(
  vaultPath: string,
  notesFolder: string,
  geminiOutput: string,
  utterances: Utterance[],
  speakerMap: Map<string, string>,
  unknownSpeakers: string[],
  recordingDate: Date,
): string {
  const folderPath = join(vaultPath, notesFolder);
  if (!existsSync(folderPath)) {
    mkdirSync(folderPath, { recursive: true });
  }

  // Determine filename
  const title = extractTitle(geminiOutput);
  const datePrefix = recordingDate.toISOString().slice(0, 10);
  const filename = `${datePrefix} ${sanitizeFilename(title)}.md`;
  const filePath = join(folderPath, filename);

  // Build title and date header
  let noteTitle: string;
  let notesBody: string;

  if (geminiOutput.startsWith("# ")) {
    const firstNewline = geminiOutput.indexOf("\n");
    noteTitle = geminiOutput.slice(2, firstNewline).trim();
    notesBody = geminiOutput.slice(firstNewline + 1).trim();
  } else {
    noteTitle = "Meeting Notes";
    notesBody = geminiOutput;
  }

  const dateStr = recordingDate.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const timeStr = recordingDate.toTimeString().slice(0, 5);

  // Build unknown speakers section
  let unknownSection = "";
  if (unknownSpeakers.length > 0) {
    const lines = unknownSpeakers.map(
      (label) => `- Speaker ${label}:`,
    );
    unknownSection = `> **Unknown Speakers** — Fill in names and run the command below to update this note and enroll voices.
>
${lines.map((l) => `> ${l}`).join("\n")}
>
> \`\`\`
> npx tsx src/index.ts label "${filePath}"
> \`\`\`

`;
  }

  // Build transcript section
  const transcript = utterances
    .map((u) => {
      const name = speakerMap.get(u.speaker) ?? `Speaker ${u.speaker}`;
      return `**${name}:** ${u.text}`;
    })
    .join("\n\n");

  const markdown = `## ${noteTitle}
*${dateStr} at ${timeStr}*

${unknownSection}${notesBody}

---

### Transcript

${transcript}`;

  writeFileSync(filePath, markdown, "utf-8");
  return filePath;
}

/**
 * Parse the unknown speakers section from a note file.
 * Returns a map of speaker label → user-provided name (only for filled-in entries).
 */
export function parseUnknownSpeakers(
  filePath: string,
): Map<string, string> {
  const content = readFileSync(filePath, "utf-8");
  const result = new Map<string, string>();

  // Match lines like "> - Speaker A: Marc" or "> - Speaker B: Sarah Chen"
  const regex = /^> - Speaker ([A-Z]):\s*(.+)$/gm;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const label = match[1];
    const name = match[2].trim();
    if (name) {
      result.set(label, name);
    }
  }

  return result;
}

/**
 * Apply speaker labels to a note file:
 * - Replace "Speaker X" with the real name throughout the note
 * - Remove labeled speakers from the unknown speakers section
 * - Remove the entire section + command if all speakers are labeled
 */
export function applyLabels(
  filePath: string,
  labels: Map<string, string>,
): void {
  let content = readFileSync(filePath, "utf-8");

  for (const [label, name] of labels) {
    // Replace in transcript: **Speaker A:** → **Marc:**
    content = content.replaceAll(`**Speaker ${label}:**`, `**${name}:**`);
    // Replace in body text: Speaker A → name
    content = content.replaceAll(`Speaker ${label}`, name);
    // Remove the labeled line from the unknown section
    const lineRegex = new RegExp(`^> - Speaker ${label}:.*$\\n?`, "gm");
    content = content.replace(lineRegex, "");
  }

  // Check if any unknown speakers remain
  const hasRemaining = /^> - Speaker [A-Z]:/.test(content);
  if (!hasRemaining) {
    // Remove the entire unknown speakers block (blockquote + command)
    content = content.replace(
      /> \*\*Unknown Speakers\*\*.*?> ```\n\n/s,
      "",
    );
  }

  writeFileSync(filePath, content, "utf-8");
}
