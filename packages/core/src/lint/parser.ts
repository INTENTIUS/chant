import * as ts from "typescript";
import { readFileSync } from "fs";

/**
 * Parse a TypeScript file into an AST
 * @param path - Absolute or relative path to the TypeScript file
 * @returns Parsed TypeScript SourceFile
 * @throws Error if the file cannot be read or parsed
 */
export function parseFile(path: string): ts.SourceFile {
  let content: string;

  try {
    content = readFileSync(path, "utf-8");
  } catch (err) {
    throw new Error(`Failed to read file ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const sourceFile = ts.createSourceFile(
    path,
    content,
    ts.ScriptTarget.Latest,
    true // setParentNodes
  );

  // Check for syntax errors (parseDiagnostics is internal but accessible)
  const diagnostics = [
    ...(sourceFile as unknown as { parseDiagnostics: ts.DiagnosticWithLocation[] }).parseDiagnostics,
  ];

  if (diagnostics.length > 0) {
    const errors = diagnostics
      .map((d) => {
        const { line, character } = sourceFile.getLineAndCharacterOfPosition(d.start ?? 0);
        return `${path}:${line + 1}:${character + 1} - ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`;
      })
      .join("\n");
    throw new Error(`TypeScript parsing failed:\n${errors}`);
  }

  return sourceFile;
}
