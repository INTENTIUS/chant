/**
 * A MySQL column type as the value mysql2 hands back for it, for
 * `chant sql types` (#5449). chant's own connections read dates and big
 * numbers as strings, and an application's driver settings may differ, so
 * a type whose value depends on them (`BIGINT`, `DECIMAL`, the dates) is
 * typed as the string the driver gives when told to keep them exact.
 */

import { TYPE_SPELLINGS, COLUMN_TYPES } from "../generated/mysql";
import { stringValue, tokenizeText } from "./tokens";

const SPELLINGS: Readonly<Record<string, string>> = TYPE_SPELLINGS;

/** A column type's spelling, row type and comparison family. */
export function mysqlColumnType(text: string): { sqlType: string; ts: string; cmp?: string } {
  const sqlType = text.trim();
  const words = sqlType.toUpperCase().split(/[\s(]+/);
  const name = SPELLINGS[`${words[0]} ${words[1] ?? ""}`.trim()] ?? SPELLINGS[words[0] ?? ""];
  const row = name ? COLUMN_TYPES[name as keyof typeof COLUMN_TYPES] : undefined;
  if (!name || !row) return { sqlType, ts: "unknown" };
  const family = row.family;
  let ts: string;
  if (name === "BIGINT" || family === "fixed") ts = "string";
  else if (name === "BOOLEAN" || /^TINYINT\s*\(\s*1\s*\)/i.test(sqlType)) ts = "number";
  else if (family === "integer" || family === "float") ts = "number";
  else if (name === "YEAR") ts = "number";
  else if (family === "temporal" || family === "character" || family === "text") ts = "string";
  else if (family === "enumeration" && name === "ENUM") {
    const values = tokenizeText(sqlType, 0).filter((t) => t.kind === "string").map((t) => JSON.stringify(stringValue(t.text)));
    ts = values.length > 0 ? values.join(" | ") : "string";
  } else if (family === "enumeration") ts = "string";
  else if (family === "binary" || family === "blob" || family === "bit") ts = "Uint8Array";
  else ts = "unknown";
  return { sqlType, ts, cmp: family };
}
