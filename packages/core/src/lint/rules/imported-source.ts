import * as ts from "typescript";

/**
 * The first comment line of a file written by `chant import`.
 *
 * An imported declaration keeps the name the source template gave it, and the
 * name is part of what the template deploys, so a naming or an
 * unreferenced-declaration finding on it asks for a change that alters the
 * deployed resources. COR004 and COR005 read this line and skip the file.
 */
export const IMPORTED_SOURCE_MARKER = "// chant:imported";

/** The header `chant import` puts on a generated TypeScript file. */
export const IMPORTED_SOURCE_HEADER =
  `${IMPORTED_SOURCE_MARKER} - declarations keep the names of the source template; COR004 and COR005 skip this file.\n`;

/** Prefix the marker onto generated content once; other file types are returned as they are. */
export function markImportedSource(path: string, content: string): string {
  if (!path.endsWith(".ts") || content.startsWith(IMPORTED_SOURCE_MARKER)) return content;
  return IMPORTED_SOURCE_HEADER + content;
}

/**
 * True when the marker is one of the comments that open the file. A marker
 * further down, after code, does not count.
 */
export function isImportedSource(sourceFile: ts.SourceFile): boolean {
  const text = sourceFile.text;
  const ranges = ts.getLeadingCommentRanges(text, 0) ?? [];
  return ranges.some((r) => text.startsWith(IMPORTED_SOURCE_MARKER, r.pos));
}
