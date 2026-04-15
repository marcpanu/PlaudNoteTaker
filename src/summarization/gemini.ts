const API_BASE =
  "https://generativelanguage.googleapis.com/v1beta/models";

interface GeminiResponse {
  candidates: {
    content: {
      parts: { text: string }[];
    };
  }[];
}

export async function summarizeTranscript(
  transcriptText: string,
  template: string,
  apiKey: string,
  model: string,
): Promise<string> {
  const prompt = template.includes("{{transcript}}")
    ? template.replace("{{transcript}}", transcriptText)
    : template + "\n\n## Transcript:\n" + transcriptText;

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
  return data.candidates[0].content.parts[0].text;
}
