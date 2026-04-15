import { readFileSync, existsSync, readdirSync } from "fs";
import { join, resolve } from "path";

export const DEFAULT_TEMPLATE = `You are a meeting notes assistant. Given the following meeting transcript with speaker labels, produce structured meeting notes in markdown format.

## Output format:

Your response MUST begin with two special lines before anything else:

Line 1 — the target folder, prefixed with "FOLDER: ". Choose the most appropriate folder from the list provided below. If no folder is a good fit, suggest a new subfolder path that fits the content.
Line 2 — the title, prefixed with "# " (markdown H1). A concise, descriptive summary of the meeting topic (e.g., "# Q2 Marketing Strategy Review"). Do NOT include a date in the title.

Then include the following sections:

### Attendees
List each speaker with their name. If their role or organization is mentioned in the conversation, include it.

### Summary
Provide a clear overall summary of the meeting. Use a mix of prose and bullet points as appropriate to capture key discussion points, decisions made, and important context.

### Action Items
List action items as a task list. Tag each with the owner.
- [ ] **Owner:** Description of the action item

{{vault_folders}}

## Transcript:
{{transcript}}`;

export function loadTemplate(
  templatesPath: string,
  selectedTemplate: string,
): string {
  if (!templatesPath) return DEFAULT_TEMPLATE;

  const resolvedPath = resolve(templatesPath);
  if (!existsSync(resolvedPath)) {
    console.warn(
      `Templates path not found: ${resolvedPath}, using default template`,
    );
    return DEFAULT_TEMPLATE;
  }

  const templateFile = join(resolvedPath, `${selectedTemplate}.md`);
  if (!existsSync(templateFile)) {
    console.warn(
      `Template "${selectedTemplate}.md" not found in ${resolvedPath}, using default template`,
    );
    return DEFAULT_TEMPLATE;
  }

  return readFileSync(templateFile, "utf-8");
}

export function listTemplates(templatesPath: string): string[] {
  if (!templatesPath || !existsSync(templatesPath)) return [];
  return readdirSync(templatesPath)
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""));
}
