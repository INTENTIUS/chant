/**
 * File marker interpolation and MDX escaping utilities.
 */

import { readFileSync } from "fs";
import { join } from "path";

/** Escape curly braces so MDX doesn't treat them as JSX expressions. */
export function escapeMdx(text: string): string {
  return text.replace(/\{/g, "\\{").replace(/\}/g, "\\}");
}

/**
 * Expand `{{file:path.ts}}` markers in content with fenced code blocks.
 *
 * Supported forms:
 * - `{{file:path.ts}}` — full file
 * - `{{file:path.ts:5-12}}` — lines 5–12 (1-based, inclusive)
 * - `{{file:path.ts|title=custom.ts}}` — override the code block title
 * - `{{file:path.ts:5-12|title=custom.ts}}` — both
 */
export function expandFileMarkers(content: string, examplesDir: string): string {
  return content.replace(
    /\{\{file:([^}]+)\}\}/g,
    (_match, spec: string) => {
      // Parse options after |
      let filePart = spec;
      let title: string | undefined;
      const pipeIdx = spec.indexOf("|");
      if (pipeIdx !== -1) {
        filePart = spec.substring(0, pipeIdx);
        const opts = spec.substring(pipeIdx + 1);
        const titleMatch = opts.match(/title=([^\s|]+)/);
        if (titleMatch) title = titleMatch[1];
      }

      // Parse line range after :digits-digits at end of filePart
      let lineStart: number | undefined;
      let lineEnd: number | undefined;
      const rangeMatch = filePart.match(/^(.+):(\d+)-(\d+)$/);
      if (rangeMatch) {
        filePart = rangeMatch[1];
        lineStart = parseInt(rangeMatch[2], 10);
        lineEnd = parseInt(rangeMatch[3], 10);
      }

      const filePath = join(examplesDir, filePart);
      let fileContent: string;
      try {
        fileContent = readFileSync(filePath, "utf-8");
      } catch {
        throw new Error(`File marker {{file:${spec}}} — file not found: ${filePath}`);
      }

      // Extract line range if specified
      if (lineStart !== undefined && lineEnd !== undefined) {
        const lines = fileContent.split("\n");
        fileContent = lines.slice(lineStart - 1, lineEnd).join("\n");
      }

      // Determine language from extension
      const ext = filePart.substring(filePart.lastIndexOf(".") + 1);
      const lang = ext === "ts" || ext === "tsx" ? "typescript" : ext;
      const displayTitle = title ?? filePart.substring(filePart.lastIndexOf("/") + 1);

      return `\`\`\`${lang} title="${displayTitle}"\n${fileContent.trimEnd()}\n\`\`\``;
    },
  );
}
