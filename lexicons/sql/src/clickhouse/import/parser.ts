/**
 * `chant import schema.sql`: a file of ClickHouse CREATE statements into the
 * import IR. Each statement must parse; one that does not is reported in the
 * IR's warnings and left out, with the parser's message.
 */

import type { TemplateIR, TemplateParser } from "@intentius/chant/import/parser";
import { describeStatement, objectsToIR, splitStatements, type ImportedObject } from "./ir";

export class ClickHouseSqlParser implements TemplateParser {
  parse(content: string): TemplateIR {
    const objects: ImportedObject[] = [];
    const warnings: string[] = [];
    for (const stmt of splitStatements(content)) {
      if (!/^\s*CREATE\b/i.test(stmt)) {
        warnings.push(`not a CREATE statement, left out: ${stmt.split("\n")[0]!.slice(0, 80)}`);
        continue;
      }
      try {
        objects.push(describeStatement(stmt));
      } catch (err) {
        warnings.push(`does not parse, left out (${(err as Error).message}): ${stmt.split("\n")[0]!.slice(0, 80)}`);
      }
    }
    return objectsToIR(objects, warnings);
  }
}
