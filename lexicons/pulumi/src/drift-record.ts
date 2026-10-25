/**
 * The drift adapter for a Pulumi member (#4453): `pulumi refresh
 * --preview-only --json` into `@intentius/chant/drift-record` records, read
 * `refresh`, engine `pulumi`.
 *
 * A refresh preview reads each resource from its provider and says how it
 * differs from the stack's state, without writing the state. chant narrows it
 * to one resource with `--target <urn>`, so one slow or failing resource
 * holds back only its own record, and a stream can send each record as its
 * read finishes. {@link pulumiRefreshDriftRecords} takes one read per URN;
 * {@link pulumiRefreshDocumentRecords} takes one untargeted refresh and makes
 * a record per resource in it.
 *
 * | step | status |
 * |---|---|
 * | `same` | in-sync |
 * | `update` | drifted, a path per `detailedDiff` key (else per `diffReasons` key, else per output that differs) |
 * | `delete` | missing |
 * | `refresh` | by its states: no new state, or one marked `delete`, is missing; outputs that differ are drifted; else in-sync |
 * | anything else | not-observed, `read-failed`, the op in `evidence.engineCode` |
 * | no step for the target | not-observed, `not-reached` |
 * | the run failed | not-observed, with the reason the runner gave |
 *
 * `before` is what the state recorded and `after` what the provider read.
 * A path whose `detailedDiff` says `inputDiff` reads the inputs, any other
 * the outputs. A value that is or holds a secret, on either side, is
 * `sensitive: true` with neither value; the record constructor's key-name
 * pass runs after. The URN is the record's `address`, and its `node` the one
 * URN rule's (`@intentius/chant/pulumi-urn`, #4456) through the change set's
 * `pulumi` planner. Providers and the root stack are not resources anyone
 * drifts and get no record.
 *
 * The design record (#4450) takes the step ops as `same`, `update` and
 * `delete`; Pulumi may print `refresh` with both states instead, so both are
 * read. The fixtures under `testdata/pulumi-refresh` are hand-written to the
 * documented `--json` shape, not recorded from a real run, and the shape
 * still wants checking against one.
 *
 * Imports chant's `drift-record` and `pulumi-urn` subpaths and `./values`,
 * never the lexicon's entry point, so it bundles small (#3421).
 */

import {
  driftRecord,
  placeDriftRecord,
  type DriftAdapterBase,
  type DriftAttribute,
  type DriftEvidence,
  type DriftRecord,
} from "@intentius/chant/drift-record";
import type { UnobservedReason } from "@intentius/chant/observation";
import { isPulumiNodeless, parsePulumiUrn } from "@intentius/chant/pulumi-urn";
import { pulumiSteps, type PulumiStep, type PulumiStepState } from "./change-set";
import { holdsSecret, isObject, isUnknown, propertyKeys, sameJson, valueAtPath } from "./values";

const byString = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The argv chant runs for one resource's refresh read, after `pulumi`. */
export function pulumiRefreshArgs(opts: { urn?: string; stack?: string } = {}): string[] {
  return [
    "refresh",
    "--preview-only",
    "--json",
    ...(opts.stack ? ["--stack", opts.stack] : []),
    ...(opts.urn ? ["--target", opts.urn] : []),
  ];
}

/** One `--target`ed refresh read: the URN asked for, and the document or why there is none. */
export interface PulumiRefreshRead {
  urn: string;
  /** `pulumi refresh --preview-only --json --target <urn>`, parsed. */
  refresh?: unknown;
  /** The run failed or printed nothing readable. */
  failed?: { reason: UnobservedReason; detail?: string };
}

export interface PulumiRefreshDriftInput extends DriftAdapterBase {
  reads: readonly PulumiRefreshRead[];
  /** The stack read, for the evidence's command line. */
  stack?: string;
}

/** What every refresh adapter takes: the adapter base and the stack. */
type RefreshBase = DriftAdapterBase & { stack?: string };

function evidenceFor(input: Pick<RefreshBase, "version" | "stack">, urn: string | undefined, op?: string): DriftEvidence {
  return {
    tool: "pulumi",
    ...(input.version ? { version: input.version } : {}),
    command: `pulumi ${pulumiRefreshArgs({ urn, stack: input.stack }).join(" ")}`,
    ...(op ? { engineCode: op } : {}),
  };
}

function common(input: DriftAdapterBase, urn: string, state?: PulumiStepState) {
  const type = state?.type ?? parsePulumiUrn(urn)?.type;
  return {
    member: input.member,
    engine: "pulumi" as const,
    address: urn,
    ...(type ? { resourceType: type } : {}),
    ...placeDriftRecord(input, "pulumi", urn),
    observedAt: input.observedAt,
    read: "refresh" as const,
    ...(input.fellBackFrom !== undefined ? { fellBackFrom: input.fellBackFrom } : {}),
  };
}

/** The paths that differ between a refresh step's states, and which side of the state each reads. */
function driftPaths(step: PulumiStep): { path: string; inputs: boolean }[] {
  const detailed = isObject(step.detailedDiff) ? step.detailedDiff : undefined;
  if (detailed && Object.keys(detailed).length > 0) {
    return Object.entries(detailed).map(([path, d]) => ({ path, inputs: d?.inputDiff === true }));
  }
  if (Array.isArray(step.diffReasons) && step.diffReasons.length > 0) {
    return step.diffReasons.map((path) => ({ path: String(path), inputs: false }));
  }
  const before = step.oldState?.outputs ?? {};
  const after = step.newState?.outputs ?? {};
  return [...new Set([...propertyKeys(before), ...propertyKeys(after)])]
    .filter((k) => !sameJson(before[k] ?? null, after[k] ?? null))
    .map((path) => ({ path, inputs: false }));
}

function attributesOf(step: PulumiStep): DriftAttribute[] {
  const seen = new Set<string>();
  const out: DriftAttribute[] = [];
  for (const { path, inputs } of driftPaths(step)) {
    if (seen.has(path)) continue;
    seen.add(path);
    const before = valueAtPath(inputs ? step.oldState?.inputs : step.oldState?.outputs, path);
    const after = valueAtPath(inputs ? step.newState?.inputs : step.newState?.outputs, path);
    if (holdsSecret(before) || holdsSecret(after)) {
      out.push({ path, sensitive: true });
      continue;
    }
    out.push({
      path,
      ...(before !== undefined && before !== null && !isUnknown(before) ? { before } : {}),
      ...(after !== undefined && after !== null && !isUnknown(after) ? { after } : {}),
    });
  }
  return out;
}

/** The record one URN's refresh steps give. */
function recordFor(input: RefreshBase, urn: string, steps: PulumiStep[], targeted: boolean): DriftRecord {
  const step = steps[steps.length - 1];
  const op = step.op ?? "";
  const state = step.newState ?? step.oldState;
  const at = common(input, urn, state);
  const evidence = evidenceFor(input, targeted ? urn : undefined, op || undefined);
  const missing = () => driftRecord({ ...at, status: "missing", evidence });
  const compared = () => {
    const attributes = attributesOf(step);
    return attributes.length === 0
      ? driftRecord({ ...at, status: "in-sync", evidence })
      : driftRecord({ ...at, status: "drifted", attributes, evidence });
  };
  switch (op) {
    case "same":
      return driftRecord({ ...at, status: "in-sync", evidence });
    case "update":
      return compared();
    case "delete":
      return missing();
    case "refresh":
      if (!isObject(step.newState) || step.newState.delete === true) return missing();
      return compared();
    default:
      return driftRecord({
        ...at,
        status: "not-observed",
        unobserved: { reason: "read-failed", detail: `pulumi printed ${op ? `op ${op}` : "a step with no op"} for the URN, which a refresh read does not map`, queried: urn },
        evidence,
      });
  }
}

/**
 * One record per `--target`ed read: what the refresh found for the URN asked
 * for. Steps for other URNs in the same document (the stack, a provider)
 * are not this read's answer and are left out. Sorted by address.
 */
export function pulumiRefreshDriftRecords(input: PulumiRefreshDriftInput): DriftRecord[] {
  const out: DriftRecord[] = [];
  for (const read of input.reads) {
    const at = common(input, read.urn);
    if (read.failed) {
      out.push(driftRecord({ ...at, status: "not-observed", unobserved: { ...read.failed, queried: read.urn }, evidence: evidenceFor(input, read.urn) }));
      continue;
    }
    const steps = (pulumiSteps(read.refresh) ?? []).filter((s) => s.urn === read.urn);
    if (steps.length === 0) {
      const why = pulumiSteps(read.refresh) === undefined ? 'the refresh printed no "steps"' : "the refresh printed no step for the URN";
      out.push(driftRecord({ ...at, status: "not-observed", unobserved: { reason: "not-reached", detail: why, queried: read.urn }, evidence: evidenceFor(input, read.urn) }));
      continue;
    }
    out.push(recordFor(input, read.urn, steps, true));
  }
  return out.sort((a, b) => byString(a.address, b.address));
}

export interface PulumiRefreshDocumentInput extends DriftAdapterBase {
  /** One untargeted `pulumi refresh --preview-only --json`, parsed. */
  refresh: unknown;
  stack?: string;
}

/**
 * One record per resource of an untargeted refresh, providers and the root
 * stack left out. Throws when the document has no `steps`. Sorted by address.
 */
export function pulumiRefreshDocumentRecords(input: PulumiRefreshDocumentInput): DriftRecord[] {
  const steps = pulumiSteps(input.refresh);
  if (steps === undefined) throw new Error('not a pulumi refresh --preview-only --json document: no top-level "steps"');
  const byUrn = new Map<string, PulumiStep[]>();
  for (const s of steps) {
    const type = s.newState?.type ?? s.oldState?.type ?? parsePulumiUrn(s.urn!)?.type ?? "";
    if (isPulumiNodeless(type)) continue;
    byUrn.set(s.urn!, [...(byUrn.get(s.urn!) ?? []), s]);
  }
  return [...byUrn].map(([urn, list]) => recordFor(input, urn, list, false)).sort((a, b) => byString(a.address, b.address));
}
