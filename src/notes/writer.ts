import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
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

export function buildMarkdown(
  geminiOutput: string,
  utterances: Utterance[],
  speakerMap: Map<string, string>,
  recordingDate: Date,
): string {
  // Extract title from Gemini output
  let title: string;
  let notesBody: string;

  if (geminiOutput.startsWith("# ")) {
    const firstNewline = geminiOutput.indexOf("\n");
    title = geminiOutput.slice(2, firstNewline).trim();
    notesBody = geminiOutput.slice(firstNewline + 1).trim();
  } else {
    title = "Meeting Notes";
    notesBody = geminiOutput;
  }

  const dateStr = recordingDate.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const timeStr = recordingDate.toTimeString().slice(0, 5);

  // Build transcript section
  const transcript = utterances
    .map((u) => {
      const name = speakerMap.get(u.speaker) ?? `Speaker ${u.speaker}`;
      return `**${name}:** ${u.text}`;
    })
    .join("\n\n");

  return `
---
## ${title}
*${dateStr} at ${timeStr}*

${notesBody}

---

### Transcript

${transcript}

---
`.trim();
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

export function writeNote(
  vaultPath: string,
  notesFolder: string,
  markdown: string,
  title: string,
  recordingDate: Date,
): string {
  const folderPath = join(vaultPath, notesFolder);
  if (!existsSync(folderPath)) {
    mkdirSync(folderPath, { recursive: true });
  }

  const datePrefix = recordingDate.toISOString().slice(0, 10);
  const filename = `${datePrefix} ${sanitizeFilename(title)}.md`;
  const filePath = join(folderPath, filename);

  writeFileSync(filePath, markdown, "utf-8");
  return filePath;
}
