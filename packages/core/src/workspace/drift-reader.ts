/**
 * A kind's drift reader (#5068).
 *
 * A kinds file can name a drift reader module beside its graph reader:
 *
 * ```json
 * "drift": { "reader": "dist/drift-reader.mjs", "config": { "dir": "{dir}", "file": "governance.yml" } }
 * ```
 *
 * `chant workspace drift --member <name>` imports the module for a member of
 * that kind and calls its default export with {@link DriftReaderInput}. It
 * answers as a lexicon's `readDrift` answers `chant lifecycle drift`
 * ({@link DriftReaderOutput}, `ReadDriftResult` in `../drift-record.ts`):
 * the drift stream lines of each read it ran, or a refusal. Its schema is
 * `./drift-reader.schema.json`, `$id` {@link DRIFT_READER_SCHEMA_ID}.
 *
 * The module runs in the process of the chant that reads the workspace, with
 * that process's environment, so a reader that asks a forge brings its own
 * credentials from there. chant makes no call to the forge for it. Each line
 * the module returns is checked with the drift record's codec
 * (`decodeDriftLine`), so a state read that says in-sync, or a not-observed
 * record with no reason, fails the read rather than reaching a renderer.
 */

import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { decodeDriftLine, type DriftLine, type DriftRead, type ReadDriftRefusalCode, type ReadDriftResult } from "../drift-record";

/** The schema a drift reader's output holds to. */
export const DRIFT_READER_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/drift-reader/v1/drift-reader.schema.json";

/** What a drift reader module's default export is called with. */
export interface DriftReaderInput {
  /** The member's directory, absolute: the kind config's `dir` when it sets one as a string, else the member's own directory. */
  dir: string;
  /** The kind's `drift.config`, with `{member}`, `{dir}` and `{workspace}` substituted. */
  config: Record<string, unknown>;
  /** The workspace member the records are for. chant puts this name on every line whatever the reader writes. */
  member: string;
  /** RFC 3339, the `observedAt` to give every record the reader builds. */
  observedAt: string;
  /** `--read`, when given. Unset, the reader's default read. */
  read?: DriftRead;
  /** `--resource`, when given: one address to read. */
  resource?: string;
  /** `--stack`, when given. */
  stack?: string;
}

/** What a drift reader module returns: the same answer as a lexicon's `readDrift`. */
export type DriftReaderOutput = ReadDriftResult;

/** A drift reader module's default export. */
export type DriftReader = (input: DriftReaderInput) => DriftReaderOutput | Promise<DriftReaderOutput>;

const REFUSAL_CODES: readonly ReadDriftRefusalCode[] = ["read-unsupported", "resource-unsupported", "no-drift-read"];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Check what a reader returned: each line through the drift codec, a
 * refusal's code against the closed list. `error` says why it is not an
 * answer.
 */
export function checkDriftReaderOutput(out: unknown): DriftReaderOutput | { error: string } {
  if (!isObject(out)) return { error: "returned something that is not an object with lines or refused" };
  if ("refused" in out) {
    const refused = out.refused;
    if (!isObject(refused) || !(REFUSAL_CODES as readonly unknown[]).includes(refused.code) || typeof refused.message !== "string" || refused.message === "") {
      return { error: `returned a refusal that is not { code: ${REFUSAL_CODES.join(" | ")}, message }` };
    }
    return { refused: { code: refused.code as ReadDriftRefusalCode, message: refused.message } };
  }
  if (!Array.isArray(out.lines)) return { error: "returned something with no lines array and no refusal" };
  const lines: DriftLine[] = [];
  for (const [i, line] of out.lines.entries()) {
    try {
      lines.push(decodeDriftLine(JSON.stringify(line)));
    } catch (err) {
      return { error: `returned a line ${i} that is not drift: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return { lines };
}

/** Import the module and call it, or say why not. Never throws. */
export async function readDriftWithModule(module: string, input: DriftReaderInput): Promise<DriftReaderOutput | { error: string }> {
  if (!isAbsolute(module)) return { error: `drift reader ${module} must be an absolute path` };
  let read: unknown;
  try {
    read = ((await import(pathToFileURL(module).href)) as { default?: unknown }).default;
  } catch (err) {
    return { error: `drift reader ${module} could not be loaded: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (typeof read !== "function") return { error: `drift reader ${module} has no default export function` };
  let out: unknown;
  try {
    out = await (read as DriftReader)(input);
  } catch (err) {
    return { error: `drift reader ${module} failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const checked = checkDriftReaderOutput(out);
  return "error" in checked ? { error: `drift reader ${module} ${checked.error}` } : checked;
}
