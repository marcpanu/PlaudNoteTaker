const API_BASE =
  "https://generativelanguage.googleapis.com/v1beta/models";

interface GeminiResponse {
  candidates: {
    content: {
      parts: { text: string }[];
    };
  }[];
}

export interface SummaryResult {
  folder: string;
  rawOutput: string; // everything after the FOLDER line
}

export async function summarizeTranscript(
  transcriptText: string,
  template: string,
  vaultFolders: string,
  apiKey: string,
  model: string,
): Promise<SummaryResult> {
  // Inject vault folders into template
  let prompt: string;
  const foldersSection = vaultFolders
    ? `## Available vault folders:\n\`\`\`\n${vaultFolders}\n\`\`\``
    : "";

  const populatedTemplate = template
    .replace("{{vault_folders}}", foldersSection);

  if (populatedTemplate.includes("{{transcript}}")) {
    prompt = populatedTemplate.replace("{{transcript}}", transcriptText);
  } else {
    prompt = populatedTemplate + "\n\n## Transcript:\n" + transcriptText;
  }

  const response = await fetch(
    `${API_BASE}/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${body}`);
  }

  const data = (await response.json()) as GeminiResponse;
  const text = data.candidates[0].content.parts[0].text;

  return parseSummaryOutput(text);
}

function parseSummaryOutput(text: string): SummaryResult {
  const lines = text.split("\n");

  // Look for FOLDER: line (may or may not be first line)
  let folder = "";
  let startIndex = 0;

  for (let i = 0; i < Math.min(lines.length, 5); i++) {
    if (lines[i].startsWith("FOLDER:")) {
      folder = lines[i].slice("FOLDER:".length).trim();
      startIndex = i + 1;
      break;
    }
  }

  const rawOutput = lines.slice(startIndex).join("\n").trim();

  return { folder, rawOutput };
}
