/**
 * The optional HCL parser, loaded lazily. Kept apart from `parse.ts` so a
 * caller that only needs the loader (the terraform lexicon's HCL reader) does
 * not pull in the dependency graph, the state reader and the carve tables.
 *
 * `@cdktn/hcl2json` is NOT a chant dependency: it carries a ~1.8 MB wasm blob
 * and only HCL users need it. If it is absent the loader fails with a
 * one-line install hint.
 */

import { appendFileSync } from "fs";
import type { Hcl2JsonTree } from "./types";

/** Minimal shape of the parser exports we depend on. */
export interface Hcl2Json {
  parse: (filename: string, hcl: string) => Promise<Hcl2JsonTree>;
  /** Expression-AST reference extraction (#998) — one traversal accessor per reference. */
  getReferencesInExpression: (filename: string, expression: string) => Promise<Array<{ value: string }>>;
}

export class Hcl2JsonNotInstalled extends Error {
  constructor(cause: unknown) {
    super(
      "Terraform carve-out needs the HCL parser, which is not installed.\n" +
        "  Install it once:  npm install -D @cdktn/hcl2json\n" +
        `(underlying error: ${cause instanceof Error ? cause.message : String(cause)})`,
    );
    this.name = "Hcl2JsonNotInstalled";
  }
}

/**
 * The environment variable that turns on parser-input recording (chant #2483).
 *
 * When set to a file path, every `parse(filename, source)` and every
 * `getReferencesInExpression(filename, expression)` this process makes is
 * appended to that file as one JSON line before the real call runs. That is
 * how `scripts/check-hcl-parser-parity.ts` gets hold of the inline HCL the
 * test suite parses, which no corpus walk on disk would find: run the suite
 * with this set, then replay the file through two parsers and compare. Off
 * unless set, and never changes a result.
 */
export const HCL2JSON_RECORD_ENV = "CHANT_HCL2JSON_RECORD";

/** One recorded parser input, as {@link HCL2JSON_RECORD_ENV} writes it. */
export interface Hcl2JsonRecordLine {
  kind: "parse" | "refs";
  filename: string;
  text: string;
}

function recording(parser: Hcl2Json, path: string): Hcl2Json {
  const note = (line: Hcl2JsonRecordLine): void => {
    appendFileSync(path, `${JSON.stringify(line)}\n`);
  };
  return {
    parse: (filename, hcl) => {
      note({ kind: "parse", filename, text: hcl });
      return parser.parse(filename, hcl);
    },
    getReferencesInExpression: (filename, expression) => {
      note({ kind: "refs", filename, text: expression });
      return parser.getReferencesInExpression(filename, expression);
    },
  };
}

/**
 * Lazy-load the optional HCL parser. Throws `Hcl2JsonNotInstalled` with an
 * install hint when the package is missing, rather than a raw MODULE_NOT_FOUND.
 */
export async function loadHcl2json(): Promise<Hcl2Json> {
  let parser: Hcl2Json;
  try {
    parser = (await import("@cdktn/hcl2json")) as Hcl2Json;
  } catch (err) {
    throw new Hcl2JsonNotInstalled(err);
  }
  const record = process.env[HCL2JSON_RECORD_ENV];
  return record ? recording(parser, record) : parser;
}
