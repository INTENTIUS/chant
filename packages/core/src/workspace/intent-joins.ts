/**
 * The commit-join hook of the intent graph (#2651; #2650 C1 and C13).
 *
 * Commits, decisions and artifacts come from core. Units of work, contracts
 * and evidence come from a plugin, such as chud's development model, because
 * core ships no model of them (#2555, "Core ships no decision kind"). A kind
 * file passed to `chant workspace graph --intent --kind <file>` supplies them
 * through one export, `commitJoins`, in one of two forms:
 *
 * - A function `commitJoins(commit, context)` that returns the unit, contract
 *   and evidence for one commit, or nothing. It is given the commit's sha,
 *   subject, body, author, date and trailers, and a `read` function for files
 *   at the revision read.
 * - Data, which core interprets with no plugin code: the trailer keys that
 *   name a unit, a contract or evidence, the record paths to read for each
 *   (`units/{id}.json`), and the trailer keys that claim authorship.
 *
 * Either way core never parses a plugin's own trailer or record format: it
 * reads the trailers git reports and hands them over, and a key means
 * something only because a kind file said so.
 *
 * Two parts of a join's answer carry meaning core acts on (#2656). A unit or
 * contract may list `decisions`, the ids of the decision records it carries
 * out; a commit whose unit or contract names a decision is that decision's own
 * work. The function form may also return `findings`, each a code in the
 * kind's own namespace (`plugin:<name>:<code>`), a message and the refs it is
 * about, which the graph carries as finding nodes. That is how a plugin says
 * what it knows and core does not, such as a contract whose criteria changed
 * in a commit that names no decision.
 */

import { z } from "zod";
import { isPluginCode } from "./reason-codes";

/** A commit as the hook sees it. */
export interface IntentCommit {
  sha: string;
  subject: string;
  body: string;
  author: { name: string; email: string };
  /** Author date, ISO 8601. */
  date: string;
  /** Every trailer git parses from the message, keyed as written, with each value in order. */
  trailers: Record<string, string[]>;
}

export interface CommitJoinContext {
  /** The text of a file from the workspace root, in the tree read; undefined when it is not a file there. */
  read(path: string): string | undefined;
  /** The full commit id read with `--at`, or null for the working tree. */
  at: string | null;
}

/**
 * A plugin's unit, contract or evidence: an id and whatever fields the plugin
 * records. On a unit or contract, `decisions`, a list of record ids, names the
 * decisions it carries out (#2656).
 */
export interface JoinedEntity {
  id: string;
  [field: string]: unknown;
}

/** A finding a plugin contributes for one commit (#2656). */
export interface PluginFinding {
  /** `plugin:<name>:<code>`, where `<name>` is the kind's name. */
  code: string;
  message: string;
  /** What the finding is about: node ids, commit shas, record ids, unit, contract or evidence ids, or paths. */
  refs?: string[];
}

/** What a join says about one commit. Every part is optional. */
export interface CommitJoin {
  /** The unit of work that produced the commit. */
  unit?: JoinedEntity;
  /** The contract the unit served. */
  contract?: JoinedEntity;
  /** The evidence the unit or contract cites. */
  evidence?: JoinedEntity | JoinedEntity[];
  /** Trailer keys on this commit that claim who wrote it, which the plugin vouches for. */
  authorship?: string[];
  /** Findings about this commit, in the kind's own code namespace. Function form only. */
  findings?: PluginFinding[];
}

export type CommitJoinsFunction = (commit: IntentCommit, context: CommitJoinContext) => CommitJoin | null | undefined | Promise<CommitJoin | null | undefined>;

const trailerKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/, "a trailer key holds letters, digits and dashes");
const recordPath = z.string().min(1).refine((p) => p.includes("{id}") && !p.startsWith("/") && !p.split("/").includes(".."), "a record path is relative to the workspace root and holds {id}");

/** The data form of `commitJoins`. */
export const commitJoinsDataSchema = z
  .object({
    /** The trailer whose value is the id of the unit, contract or evidence. */
    trailers: z.object({ unit: trailerKey.optional(), contract: trailerKey.optional(), evidence: trailerKey.optional() }).strict(),
    /** Where each is recorded, from the workspace root, with `{id}` for the id. A JSON file there adds its fields. */
    records: z.object({ unit: recordPath.optional(), contract: recordPath.optional(), evidence: recordPath.optional() }).strict().optional(),
    /** Trailer keys that claim authorship, checked against the commit's provenance. */
    authorship: z.array(trailerKey).optional(),
  })
  .strict();

export type CommitJoinsData = z.infer<typeof commitJoinsDataSchema>;

/** A kind file's `commitJoins` export, checked: a function, or data. */
export type CommitJoins = { form: "function"; join: CommitJoinsFunction } | { form: "data"; data: CommitJoinsData };

/** Read a kind module's `commitJoins` export. Undefined when it has none; a string when it is malformed. */
export function readCommitJoins(mod: Record<string, unknown>): CommitJoins | string | undefined {
  const value = mod.commitJoins;
  if (value === undefined) return undefined;
  if (typeof value === "function") return { form: "function", join: value as CommitJoinsFunction };
  const parsed = commitJoinsDataSchema.safeParse(value);
  if (!parsed.success) return parsed.error.issues.map((i) => `commitJoins${i.path.length ? `.${i.path.join(".")}` : ""}: ${i.message}`).join("; ");
  return { form: "data", data: parsed.data };
}

/** The first value of trailer `key`, compared without case as git does. */
export function trailerValue(trailers: Record<string, string[]>, key: string): string | undefined {
  const want = key.toLowerCase();
  for (const [k, values] of Object.entries(trailers)) if (k.toLowerCase() === want && values.length > 0) return values[0].trim() || undefined;
  return undefined;
}

/** Whether the commit carries trailer `key`. */
export function hasTrailer(trailers: Record<string, string[]>, key: string): boolean {
  const want = key.toLowerCase();
  return Object.keys(trailers).some((k) => k.toLowerCase() === want);
}

function recordFields(template: string | undefined, id: string, context: CommitJoinContext): Record<string, unknown> {
  if (!template) return {};
  const text = context.read(template.split("{id}").join(id));
  if (text === undefined) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${template.split("{id}").join(id)} is not JSON`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const { id: _id, ...rest } = value as Record<string, unknown>;
  return rest;
}

/** Interpret the data form for one commit. Throws when a named record can't be read as JSON. */
export function joinByData(data: CommitJoinsData, commit: IntentCommit, context: CommitJoinContext): CommitJoin {
  const out: CommitJoin = {};
  for (const part of ["unit", "contract", "evidence"] as const) {
    const key = data.trailers[part];
    const id = key ? trailerValue(commit.trailers, key) : undefined;
    if (!id) continue;
    const entity: JoinedEntity = { ...recordFields(data.records?.[part], id, context), id };
    if (part === "evidence") out.evidence = entity;
    else out[part] = entity;
  }
  const claimed = (data.authorship ?? []).filter((k) => hasTrailer(commit.trailers, k));
  if (claimed.length > 0) out.authorship = claimed;
  return out;
}

/** The record ids a unit or contract says it carries out: its `decisions` field, when that is a list of strings. */
export function entityDecisions(entity: JoinedEntity | undefined): string[] {
  const list = entity?.decisions;
  return Array.isArray(list) ? list.filter((d): d is string => typeof d === "string" && d !== "") : [];
}

/**
 * Run a kind's joins for one commit, checking what a function returns.
 * `name` is the kind's name, the namespace its findings' codes must use.
 */
export async function runCommitJoins(joins: CommitJoins, commit: IntentCommit, context: CommitJoinContext, name: string): Promise<CommitJoin> {
  if (joins.form === "data") return joinByData(joins.data, commit, context);
  const result = await joins.join(commit, context);
  if (result === null || result === undefined) return {};
  if (typeof result !== "object") throw new Error("commitJoins returned something that is not an object");
  const entity = (v: unknown, what: string): JoinedEntity | undefined => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "object" || Array.isArray(v) || typeof (v as JoinedEntity).id !== "string" || (v as JoinedEntity).id === "") {
      throw new Error(`commitJoins returned a ${what} with no string id`);
    }
    return v as JoinedEntity;
  };
  const out: CommitJoin = {};
  const unit = entity(result.unit, "unit");
  const contract = entity(result.contract, "contract");
  if (unit) out.unit = unit;
  if (contract) out.contract = contract;
  if (result.evidence !== undefined && result.evidence !== null) {
    const list = Array.isArray(result.evidence) ? result.evidence : [result.evidence];
    out.evidence = list.map((e) => entity(e, "evidence")!).filter(Boolean);
  }
  if (result.authorship !== undefined) {
    if (!Array.isArray(result.authorship) || !result.authorship.every((k) => typeof k === "string")) throw new Error("commitJoins returned authorship that is not a list of trailer keys");
    out.authorship = result.authorship;
  }
  if (result.findings !== undefined && result.findings !== null) {
    if (!Array.isArray(result.findings)) throw new Error("commitJoins returned findings that are not a list");
    out.findings = result.findings.map((f: unknown) => {
      if (f === null || typeof f !== "object" || Array.isArray(f)) throw new Error("commitJoins returned a finding that is not an object");
      const { code, message, refs } = f as Record<string, unknown>;
      if (!isPluginCode(code, name)) throw new Error(`commitJoins returned the finding code ${JSON.stringify(code)}, and a plugin's codes are plugin:${name}:<code>, with <code> in lower case words joined by dashes`);
      if (typeof message !== "string" || message === "") throw new Error(`commitJoins returned the finding ${code} with no message`);
      if (refs !== undefined && (!Array.isArray(refs) || !refs.every((r) => typeof r === "string"))) throw new Error(`commitJoins returned the finding ${code} with refs that are not a list of strings`);
      return { code, message, refs: (refs as string[] | undefined) ?? [] };
    });
  }
  return out;
}
