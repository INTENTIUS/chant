/**
 * A point's inputs, read through the read contract.
 *
 * A point names each input as a read-contract output, optionally with a
 * dotted field: `work-item.criteria` is the `criteria` field of a work item as
 * `records --json` lists it (#2738). The decide activity takes, for each
 * output, what to read (`read: { "work-item": "W-002" }`), reads it the way
 * the read contract does, and gives each input its field. Values passed in
 * `inputs` are taken as given and win over read ones.
 *
 * Read by id or name here:
 *
 *   record, decision, work-item   a record, by id, from the declared record kinds (`records --json`);
 *                                 a work item also has its size, `criteria`, `files`, `words` and
 *                                 `fits_<tier>`, for the slice-tier point (`../workspace/work-size.ts`, #3150)
 *   member                        a member, by name (`ls --json`)
 *
 * The other outputs a point may name (finding, region, commit, node, gate, release,
 * environment, component) are passed in `inputs`, as the output printed them.
 * These reads never call a model, and never write. The module loads code
 * under `workspace/`, so the `decide` activity imports it on first call.
 */

import { declaredKindFiles, queryDeclaredRecords } from "../workspace/records-cli";
import { listWorkspace } from "../workspace/ls";
import { inputOutput } from "../workspace/points";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bodyText, loadRecordKind } from "../workspace/records";
import { locateWorkspace } from "../workspace/which-chant";
import { DEFAULT_TIER_LIMITS, measureWorkItem, sizeFields } from "../workspace/work-size";

/** The outputs {@link readInputs} reads by id or name. */
export const READABLE_OUTPUTS = ["record", "decision", "work-item", "member"] as const;

/** One output a decide step asked to read that could not be read. */
export class InputReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputReadError";
  }
}

/** A field of `value` by dotted path, or undefined. */
export function fieldOf(value: unknown, path: string): unknown {
  let at: unknown = value;
  for (const part of path.split(".")) {
    if (at === null || typeof at !== "object" || !Object.prototype.hasOwnProperty.call(at, part)) return undefined;
    at = (at as Record<string, unknown>)[part];
  }
  return at;
}

async function readRecord(id: string, cwd: string, output: string): Promise<Record<string, unknown>> {
  const files = declaredKindFiles(cwd);
  const set = await queryDeclaredRecords(files, { cwd });
  const unread: string[] = [];
  for (const [i, doc] of set.kinds.entries()) {
    if ("error" in doc) {
      unread.push(`${doc.declared.path}: ${doc.error.code}`);
      continue;
    }
    const found = doc.records.find((r) => r.id === id);
    if (found) {
      const record = found as unknown as Record<string, unknown>;
      // A work item's size, for the slice-tier point (#3150): criteria, files, words and fits_<tier>.
      return output === "work-item" ? { ...record, ...(await workItemSizeFields(files[i].file, found.path, found.data, cwd)) } : record;
    }
  }
  throw new InputReadError(`no declared record kind holds a record with id ${id} (read for ${output})${unread.length ? `; not read: ${unread.join(", ")}` : ""}`);
}

/** The size fields of a work item of the kind at `kindFile`, measured from its record file. Empty for a kind with no work block. */
async function workItemSizeFields(kindFile: string, path: string, data: Record<string, unknown> | null, cwd: string): Promise<Record<string, unknown>> {
  const loaded = await loadRecordKind(kindFile, cwd);
  const work = loaded.kind.work;
  if (!work) return {};
  const located = locateWorkspace(cwd);
  let body = "";
  try {
    body = bodyText(readFileSync(join(located.top ?? located.rootOnDisk, ...path.split("/")), "utf-8"));
  } catch {
    // A record that can't be read again is measured from its front matter alone.
  }
  const size = measureWorkItem(data, body, work.acceptance?.field ?? "acceptance");
  return sizeFields(size, work.tier?.limits ?? DEFAULT_TIER_LIMITS);
}

function readMember(name: string, cwd: string): Record<string, unknown> {
  const doc = listWorkspace({ cwd });
  if ("error" in doc) throw new InputReadError(`the workspace can't be listed: ${doc.error.code}: ${doc.error.message}`);
  const found = doc.members.find((m) => m.name === name);
  if (!found) throw new InputReadError(`the workspace has no member named ${name}`);
  return found as unknown as Record<string, unknown>;
}

/**
 * The value of one declared input from what was read for its output. A
 * record's field is looked up in its front matter first, then in the record
 * as `records --json` lists it (`state`, `valid`, `path`...). An input with no
 * field is the whole value.
 */
function inputValue(input: string, output: string, read: Record<string, unknown>): unknown {
  const field = input.length > output.length ? input.slice(output.length + 1) : "";
  if (field === "") return read;
  if (output === "member") return fieldOf(read, field);
  const fromData = fieldOf(read.data, field);
  return fromData !== undefined ? fromData : fieldOf(read, field);
}

export interface ReadInputsResult {
  inputs: Record<string, unknown>;
  /** Declared inputs of a read output that the value read does not have. Left out, so no table row matches on them. */
  missing: string[];
}

/**
 * Read each output `read` names, and give the point's inputs that name it
 * their values. Throws an {@link InputReadError} for an output this does not
 * read, one the point does not name, or an id that is not there.
 */
export async function readInputs(declared: string[], read: Record<string, string>, cwd: string): Promise<ReadInputsResult> {
  const named = new Set(declared.map(inputOutput));
  for (const output of Object.keys(read)) {
    if (!(READABLE_OUTPUTS as readonly string[]).includes(output)) {
      throw new InputReadError(`${output} is not read by id here; pass its values in inputs, as the read contract printed them (read takes ${READABLE_OUTPUTS.join(", ")})`);
    }
    if (!named.has(output)) throw new InputReadError(`the point reads no ${output} input (its inputs are ${declared.join(", ")})`);
  }
  const values = new Map<string, Record<string, unknown>>();
  for (const [output, id] of Object.entries(read)) {
    values.set(output, output === "member" ? readMember(id, cwd) : await readRecord(id, cwd, output));
  }
  const inputs: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const input of declared) {
    const output = inputOutput(input);
    const value = values.get(output);
    if (value === undefined) continue;
    const v = inputValue(input, output, value);
    if (v === undefined) missing.push(input);
    else inputs[input] = v;
  }
  return { inputs, missing };
}
