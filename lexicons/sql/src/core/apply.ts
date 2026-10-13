/**
 * The applier's plumbing, the same in every dialect (lexicon-authoring/
 * applying.mdx): reading a build's output, the outcome's tri-state (applied,
 * not attempted, and failed for a statement the server refused), its
 * projection onto core's apply envelope, and the ownership marker an apply
 * stamps and prunes by.
 *
 * What a dialect's applier decides for itself: the statements a change takes,
 * which changes it refuses and why, how it waits for the server, and how a
 * prune drops an object.
 */

import type { ChantConfig } from "@intentius/chant/config";
import type { OwnershipMarker } from "@intentius/chant/ownership";
import {
  applyResult,
  notAttemptedAll,
  type AppliedResource,
  type ApplyRef,
  type ApplyResult,
  type NotAttemptedResource,
  type PrunedResource,
} from "@intentius/chant/apply";

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** One object of a build's output, as the serializer wrote it. */
export interface BuildObject {
  export: string;
  type: string;
  ddl: string;
  /** The export names it references (a column reference by its object's export). */
  dependsOn: string[];
}

/**
 * The objects a `chant build` output declares for `dialect`, in creation
 * order, each passed through `map`. Takes the sql lexicon's primary output,
 * or a multi-lexicon output holding it under `sql`.
 */
export function readBuildObjects<T>(json: string, dialect: string, map: (o: BuildObject, index: number) => T): T[] {
  const raw = JSON.parse(json) as unknown;
  const doc = isObject(raw) && isObject(raw.sql) ? raw.sql : raw;
  if (!isObject(doc) || doc.dialect !== dialect || !Array.isArray(doc.objects)) {
    throw new Error(`not a sql lexicon build output: expected { dialect: "${dialect}", objects: [...] }`);
  }
  return (doc.objects as unknown[]).map((o, i) => {
    if (!isObject(o) || typeof o.export !== "string" || typeof o.ddl !== "string" || typeof o.type !== "string") {
      throw new Error(`sql build output: objects[${i}] has no export, type or ddl`);
    }
    const dependsOn = [...new Set((Array.isArray(o.dependsOn) ? o.dependsOn : []).filter((d): d is string => typeof d === "string").map((d) => d.split(".")[0]!))];
    return map({ export: o.export, type: o.type, ddl: o.ddl, dependsOn }, i);
  });
}

/** An object the server refused a statement for: attempted, and not converged. */
export interface FailedObject extends ApplyRef {
  error: string;
  /** The statements that did run before the one that failed. */
  statements: string[];
}

/** What an apply did, per object. Every declared object is in exactly one of applied, not attempted or failed. */
export interface SqlApplyOutcome {
  /** The server's address. */
  target: string;
  /** Where the binding came from, e.g. `sql.profiles.<env>`. */
  source: string;
  applied: Array<AppliedResource & { statements: string[] }>;
  pruned: Array<PrunedResource & { statement: string }>;
  notAttempted: NotAttemptedResource[];
  failed: FailedObject[];
}

/**
 * An apply in which the server refused a statement. The envelope has no
 * bucket for "attempted and not converged", so the applier finishes the rest
 * and throws this, carrying the outcome.
 */
export class SqlApplyError<O extends SqlApplyOutcome = SqlApplyOutcome> extends Error {
  constructor(
    /** The dialect as a message names it: `ClickHouse`. */
    dialect: string,
    readonly outcome: O,
  ) {
    super(
      `${dialect} apply to ${outcome.target}: ${outcome.failed.length} object(s) failed ` +
        `(${outcome.failed.map((f) => `${f.kind}/${f.name}: ${f.error}`).join("; ")}); ` +
        `${outcome.applied.length} applied, ${outcome.pruned.length} pruned, ${outcome.notAttempted.length} not attempted before and after`,
    );
    this.name = "SqlApplyError";
  }
}

/** An outcome in which nothing was attempted: every object not attempted with one reason. */
export function notAttemptedOutcome(refs: readonly ApplyRef[], reason: NotAttemptedResource["reason"], detail: string): SqlApplyOutcome {
  return { target: "", source: "", applied: [], pruned: [], notAttempted: notAttemptedAll(refs, reason, detail), failed: [] };
}

/**
 * Project an apply outcome onto core's apply envelope. The outcome keeps what
 * the envelope has no room for: the statements each object took and the
 * server they went to.
 */
export function toApplyResult(outcome: SqlApplyOutcome): ApplyResult {
  return applyResult(
    outcome.applied.map((a) => ({ kind: a.kind, name: a.name, action: a.action, ...(a.physicalId ? { physicalId: a.physicalId } : {}) })),
    outcome.pruned.map((p) => ({ kind: p.kind, name: p.name, deleted: p.deleted })),
    outcome.notAttempted.map((n): NotAttemptedResource => ({ kind: n.kind, name: n.name, reason: n.reason, ...(n.detail ? { detail: n.detail } : {}) })),
  );
}

/**
 * The marker to stamp and prune by: `stack` and `ownershipEnv` when passed,
 * else the project's `ownership` config. Undefined without a stack. `who`
 * names the caller in the error for an env an apply cannot resolve.
 */
export function resolveOwnershipMarker(
  args: { stack?: string; ownershipEnv?: string },
  config: Pick<ChantConfig, "ownership"> | undefined,
  who: string,
): OwnershipMarker | undefined {
  const o = config?.ownership;
  const configured = o && o.enabled !== false ? o : undefined;
  const stack = args.stack ?? configured?.stack;
  if (!stack) return undefined;
  const env = args.ownershipEnv ?? (typeof configured?.env === "string" ? configured.env : undefined);
  if (env === undefined && configured?.env !== undefined) {
    throw new Error(`${who}: ownership.env is a build parameter reference, which an apply cannot resolve; pass ownershipEnv`);
  }
  return { stack, ...(env ? { env } : {}) };
}

/** Changes grouped by the object they change, in order. */
export function changesByObject<C extends { object: string }>(changes: readonly C[]): Map<string, C[]> {
  const byObject = new Map<string, C[]>();
  for (const c of changes) byObject.set(c.object, [...(byObject.get(c.object) ?? []), c]);
  return byObject;
}

/**
 * The declared objects `dependsOn` names that are not on the server: declared
 * in this build, and not created or found in this apply. An object with any
 * is not attempted, `dependency-failed`, with {@link dependencyFailedDetail}.
 */
export function missingDependencies(self: string, dependsOn: readonly string[], declared: ReadonlySet<string>, onServer: ReadonlySet<string>): string[] {
  return dependsOn.filter((d) => declared.has(d) && d !== self && !onServer.has(d));
}

export const dependencyFailedDetail = (missing: readonly string[]): string =>
  `references ${missing.join(", ")}, which is not on the server: it failed or was not attempted in this apply`;
