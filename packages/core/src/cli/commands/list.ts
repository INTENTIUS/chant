import { resolve } from "path";
import { discover } from "../../discovery/index";
import { formatSuccess, formatBold } from "../format";

/**
 * List command options
 */
export interface ListOptions {
  /** Path to infrastructure directory */
  path: string;
  /** Output format */
  format: "text" | "json";
}

/**
 * A single entity in the list output
 */
export interface ListEntity {
  name: string;
  lexicon: string;
  entityType: string;
  kind: string;
}

/**
 * List command result
 */
export interface ListResult {
  /** Whether the list succeeded */
  success: boolean;
  /** Discovered entities */
  entities: ListEntity[];
  /** Formatted output */
  output: string;
}

/**
 * Execute the list command
 */
export async function listCommand(options: ListOptions): Promise<ListResult> {
  const infraPath = resolve(options.path);
  const result = await discover(infraPath);

  if (result.errors.length > 0) {
    const messages = result.errors.map((e) => e.message).join("\n");
    return { success: false, entities: [], output: messages };
  }

  // Collect entities sorted by name
  const entities: ListEntity[] = [];
  for (const [name, decl] of result.entities) {
    entities.push({
      name,
      lexicon: decl.lexicon,
      entityType: decl.entityType,
      kind: decl.kind ?? "resource",
    });
  }
  entities.sort((a, b) => a.name.localeCompare(b.name));

  let output: string;
  if (options.format === "json") {
    output = JSON.stringify(entities, null, 2);
  } else {
    output = formatTextTable(entities);
  }

  return { success: true, entities, output };
}

/**
 * Format entities as a text table
 */
function formatTextTable(entities: ListEntity[]): string {
  if (entities.length === 0) return "No entities found.";

  // Calculate column widths
  const headers = { name: "NAME", lexicon: "LEXICON", entityType: "TYPE", kind: "KIND" };
  const nameWidth = Math.max(headers.name.length, ...entities.map((e) => e.name.length));
  const lexiconWidth = Math.max(headers.lexicon.length, ...entities.map((e) => e.lexicon.length));
  const typeWidth = Math.max(headers.entityType.length, ...entities.map((e) => e.entityType.length));
  const kindWidth = Math.max(headers.kind.length, ...entities.map((e) => e.kind.length));

  const lines: string[] = [];
  lines.push(
    `${headers.name.padEnd(nameWidth)}  ${headers.lexicon.padEnd(lexiconWidth)}  ${headers.entityType.padEnd(typeWidth)}  ${headers.kind.padEnd(kindWidth)}`
  );

  for (const entity of entities) {
    lines.push(
      `${entity.name.padEnd(nameWidth)}  ${entity.lexicon.padEnd(lexiconWidth)}  ${entity.entityType.padEnd(typeWidth)}  ${entity.kind.padEnd(kindWidth)}`
    );
  }

  return lines.join("\n");
}

/**
 * Print list result to console
 */
export function printListResult(result: ListResult): void {
  if (result.output) {
    console.log(result.output);
  }
  if (result.success) {
    console.error(formatSuccess(`Found ${formatBold(String(result.entities.length))} entities`));
  }
}
