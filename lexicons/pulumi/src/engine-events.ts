/**
 * The engine event stream of `pulumi up --json`, and of `pulumi preview
 * --json` run with `PULUMI_ENABLE_STREAMING_JSON_PREVIEW=true` (#4541,
 * ruling C): one `apitype.EngineEvent` per line, the same shape for stock
 * Pulumi and plunge (`sdk/go/common/apitype/events.go`).
 *
 * The printed preview document drops policy events
 * (`pkg/backend/display/json.go` `ShowPreviewDigest`), so the pulumi-up
 * capability previews with the stream instead, and reads both the change set
 * and CrossGuard's verdict from one engine run:
 *
 * - {@link pulumiStreamPreview}: the stream turned back into the document
 *   `pulumiPreviewPart` and `pulumiPreviewDigest` read (`./change-set.ts`).
 *   Steps come from `resourcePreEvent`, filtered as the printed document
 *   filters them (`shouldShow`: a non-logical replacement step is left out,
 *   and `same` steps are kept, since chant always passes `--show-sames`).
 *   Each state is normalized to the printed form: a blinded secret envelope
 *   becomes `"[secret]"`, an empty `inputs` or `outputs` map and an empty
 *   `id` are left out, and `detailedDiff`'s `diffKind` is read as `kind`.
 *   The digest of the result equals the digest of the printed document for
 *   the same preview (checked against `testdata/pulumi-stream`).
 * - {@link pulumiPolicyEvents} and {@link pulumiPolicyFindings}: the
 *   `policyEvent` lines, as `@intentius/chant/gate-policy` findings. A
 *   `mandatory` violation denies; `advisory` ones are warnings; `disabled`
 *   ones are dropped.
 * - {@link pulumiStreamSummary}: the `summaryEvent`, and plunge's
 *   per-resource timings (INTENTIUS/plunge#55) when the steps carry them.
 *
 * During `up`, the engine may first preview: those `resourcePreEvent`s carry
 * `planning: true`. {@link pulumiAppliedSteps} keeps only the steps the update
 * ran, which is what the stock apply compares with the approved shape
 * (ruling A).
 *
 * Like `./change-set.ts`, this module imports only `./values` and types, so it
 * bundles without node's process modules.
 */

import type { GatePolicyFindings } from "@intentius/chant/gate-policy";
import type { PulumiStep, PulumiStepState } from "./change-set";
import { isObject, PULUMI_BLINDED_SECRET, PULUMI_SECRET_SIG, PULUMI_SIG_KEY, type Json } from "./values";

/** The env var that makes `preview --json` stream engine events instead of printing one document (`sdk/go/common/env/env.go`). */
export const PULUMI_STREAMING_PREVIEW_ENV = "PULUMI_ENABLE_STREAMING_JSON_PREVIEW";

/** One line of the stream, as far as this module reads it. */
export interface PulumiEngineEvent {
  sequence?: number;
  timestamp?: number;
  resourcePreEvent?: { metadata?: PulumiEventStep; planning?: boolean };
  resOutputsEvent?: { metadata?: PulumiEventStep; planning?: boolean };
  resOpFailedEvent?: { metadata?: PulumiEventStep; status?: number; steps?: number };
  policyEvent?: PulumiPolicyEvent;
  summaryEvent?: PulumiSummaryEvent;
  diagnosticEvent?: { urn?: string; message?: string; severity?: string; ephemeral?: boolean };
  preludeEvent?: { config?: Record<string, string> };
  cancelEvent?: Record<string, never>;
  errorEvent?: { error?: string };
}

/** `apitype.StepEventMetadata`. */
export interface PulumiEventStep {
  op?: string;
  urn?: string;
  type?: string;
  old?: PulumiEventState | null;
  new?: PulumiEventState | null;
  keys?: string[];
  diffs?: string[];
  detailedDiff?: Record<string, { diffKind?: string; inputDiff?: boolean }> | null;
  logical?: boolean;
  provider?: string;
  /** plunge's per-resource timings (INTENTIUS/plunge#55), when the fork prints them. */
  plungeTimings?: unknown[];
}

/** `apitype.StepEventStateMetadata`. */
export interface PulumiEventState {
  type?: string;
  urn?: string;
  custom?: boolean;
  delete?: boolean;
  id?: string;
  parent?: string;
  provider?: string;
  inputs?: Json | null;
  outputs?: Json | null;
}

/** `apitype.PolicyEvent`. */
export interface PulumiPolicyEvent {
  resourceUrn?: string;
  message?: string;
  policyName?: string;
  policyPackName?: string;
  policyPackVersion?: string;
  /** `advisory`, `mandatory`, `remediate` or `disabled`. */
  enforcementLevel?: string;
  severity?: string;
}

/** `apitype.SummaryEvent`. */
export interface PulumiSummaryEvent {
  maybeCorrupt?: boolean;
  durationSeconds?: number;
  resourceChanges?: Record<string, number>;
  isPreview?: boolean;
  result?: string;
  PolicyPacks?: Record<string, string>;
}

/** Every line of `stream` that parses as a JSON object. Other lines (a banner, a progress line) are skipped. */
export function pulumiEngineEvents(stream: string): PulumiEngineEvent[] {
  const out: PulumiEngineEvent[] = [];
  for (const line of stream.split("\n")) {
    const text = line.trim();
    if (!text.startsWith("{")) continue;
    try {
      const v = JSON.parse(text) as unknown;
      if (isObject(v)) out.push(v as PulumiEngineEvent);
    } catch {
      // A line that is not one event: the stream's events are one per line.
    }
  }
  return out;
}

/** Ops that are part of a replacement (`deploy.IsReplacementStep`). */
const REPLACEMENT_OPS = new Set(["replace", "create-replacement", "delete-replaced", "read-replacement", "discard-replaced", "import-replacement"]);

/** The printed document's filter (`shouldShow`), with `--show-sames` on: a non-logical replacement step is left out. */
function shown(m: PulumiEventStep): boolean {
  return !(m.logical !== true && REPLACEMENT_OPS.has(m.op ?? ""));
}

/** A value with every blinded secret envelope read as the printed document's `"[secret]"`. */
function blinded(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(blinded);
  if (!isObject(v)) return v;
  if (v[PULUMI_SIG_KEY] === PULUMI_SECRET_SIG) return PULUMI_BLINDED_SECRET;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, blinded(x)]));
}

/** A step state in the printed document's form (`apitype.ResourceV3`, empty fields omitted). */
function stateOf(s: PulumiEventState | null | undefined): PulumiStepState | undefined {
  if (!s || typeof s !== "object" || Array.isArray(s)) return undefined;
  const map = (m: Json | null | undefined): Json | undefined => (isObject(m) && Object.keys(m).length > 0 ? (blinded(m) as Json) : undefined);
  const inputs = map(s.inputs);
  const outputs = map(s.outputs);
  return {
    ...(s.urn ? { urn: s.urn } : {}),
    ...(typeof s.custom === "boolean" ? { custom: s.custom } : {}),
    ...(s.delete ? { delete: true } : {}),
    ...(s.id ? { id: s.id } : {}),
    ...(s.type ? { type: s.type } : {}),
    ...(s.parent ? { parent: s.parent } : {}),
    ...(inputs ? { inputs } : {}),
    ...(outputs ? { outputs } : {}),
  };
}

/** One event step as a printed preview step (`getPreviewMetadataStep`). */
export function pulumiStepOfEvent(m: PulumiEventStep): PulumiStep {
  const oldState = stateOf(m.old);
  const newState = stateOf(m.new);
  const detailedDiff = isObject(m.detailedDiff)
    ? Object.fromEntries(
        Object.entries(m.detailedDiff).map(([k, d]) => [k, { ...(typeof d?.diffKind === "string" ? { kind: d.diffKind } : {}), ...(typeof d?.inputDiff === "boolean" ? { inputDiff: d.inputDiff } : {}) }]),
      )
    : undefined;
  return {
    ...(m.op ? { op: m.op } : {}),
    ...(m.urn ? { urn: m.urn } : {}),
    ...(m.provider ? { provider: m.provider } : {}),
    ...(oldState ? { oldState } : {}),
    ...(newState ? { newState } : {}),
    ...(m.diffs?.length ? { diffReasons: [...m.diffs] } : {}),
    ...(m.keys?.length ? { replaceReasons: [...m.keys] } : {}),
    ...(detailedDiff ? { detailedDiff } : {}),
  };
}

function stepsOf(events: readonly PulumiEngineEvent[], keep: (e: { metadata?: PulumiEventStep; planning?: boolean }) => boolean): PulumiStep[] {
  const out: PulumiStep[] = [];
  for (const e of events) {
    const pre = e.resourcePreEvent;
    if (!pre || !isObject(pre.metadata) || typeof pre.metadata.urn !== "string") continue;
    if (!keep(pre) || !shown(pre.metadata)) continue;
    out.push(pulumiStepOfEvent(pre.metadata));
  }
  return out;
}

/** The diagnostics a stream printed, as the printed document lists them (ephemeral and debug ones left out). */
function diagnosticsOf(events: readonly PulumiEngineEvent[]): Array<{ urn?: string; message: string; severity: string }> {
  return events
    .map((e) => e.diagnosticEvent)
    .filter((d): d is NonNullable<PulumiEngineEvent["diagnosticEvent"]> => isObject(d) && d.ephemeral !== true && d.severity !== "debug" && typeof d.message === "string")
    .map((d) => ({ ...(d.urn ? { urn: d.urn } : {}), message: d.message!, severity: d.severity ?? "info" }));
}

/**
 * A streamed preview as the document `pulumi preview --json` prints without
 * the env var: `steps`, `diagnostics` and, from the summary, `changeSummary`.
 * What `pulumiPreviewPart` and `pulumiPreviewDigest` read.
 */
export function pulumiStreamPreview(stream: string | readonly PulumiEngineEvent[]): { steps: PulumiStep[]; diagnostics: Array<{ urn?: string; message: string; severity: string }>; changeSummary?: Record<string, number> } {
  const events = typeof stream === "string" ? pulumiEngineEvents(stream) : stream;
  const summary = events.map((e) => e.summaryEvent).find((x): x is PulumiSummaryEvent => isObject(x));
  return {
    steps: stepsOf(events, () => true),
    diagnostics: diagnosticsOf(events),
    ...(summary?.resourceChanges ? { changeSummary: summary.resourceChanges } : {}),
  };
}

/** The steps an `up` ran: its `resourcePreEvent`s outside any preview phase (`planning` unset). */
export function pulumiAppliedSteps(stream: string | readonly PulumiEngineEvent[]): PulumiStep[] {
  const events = typeof stream === "string" ? pulumiEngineEvents(stream) : stream;
  return stepsOf(events, (e) => e.planning !== true);
}

/** The URNs whose operation failed during an `up` (`resOpFailedEvent`), sorted. */
export function pulumiFailedUrns(stream: string | readonly PulumiEngineEvent[]): string[] {
  const events = typeof stream === "string" ? pulumiEngineEvents(stream) : stream;
  const urns = events.map((e) => e.resOpFailedEvent?.metadata?.urn).filter((u): u is string => typeof u === "string");
  return [...new Set(urns)].sort();
}

/** The URNs an `up` finished an operation on (`resOutputsEvent` outside a preview phase, `same` left out), sorted. */
export function pulumiLandedUrns(stream: string | readonly PulumiEngineEvent[]): string[] {
  const events = typeof stream === "string" ? pulumiEngineEvents(stream) : stream;
  const urns = events
    .map((e) => e.resOutputsEvent)
    .filter((o) => isObject(o) && o.planning !== true && o.metadata?.op !== "same")
    .map((o) => o!.metadata?.urn)
    .filter((u): u is string => typeof u === "string");
  return [...new Set(urns)].sort();
}

/** A CrossGuard violation the stream reported. */
export interface PulumiPolicyViolation {
  pack: string;
  packVersion?: string;
  policy: string;
  enforcementLevel: string;
  message: string;
  urn?: string;
  severity?: string;
}

/** The `policyEvent` lines of a stream, `disabled` ones left out. */
export function pulumiPolicyEvents(stream: string | readonly PulumiEngineEvent[]): PulumiPolicyViolation[] {
  const events = typeof stream === "string" ? pulumiEngineEvents(stream) : stream;
  const out: PulumiPolicyViolation[] = [];
  for (const e of events) {
    const p = e.policyEvent;
    if (!p || typeof p !== "object" || p.enforcementLevel === "disabled") continue;
    out.push({
      pack: p.policyPackName ?? "",
      ...(p.policyPackVersion ? { packVersion: p.policyPackVersion } : {}),
      policy: p.policyName ?? "",
      enforcementLevel: p.enforcementLevel ?? "advisory",
      message: (p.message ?? "").trim(),
      ...(p.resourceUrn ? { urn: p.resourceUrn } : {}),
      ...(p.severity ? { severity: p.severity } : {}),
    });
  }
  return out;
}

/** The rule id a CrossGuard policy is named by in chant's gate and overrides: `crossguard.<pack>.<policy>`. */
export function crossGuardRule(v: Pick<PulumiPolicyViolation, "pack" | "policy">): string {
  return `crossguard.${v.pack}.${v.policy}`;
}

/**
 * CrossGuard's violations as gate findings (`@intentius/chant/gate-policy`):
 * a `mandatory` one denies the plan, an `advisory` (or `remediate`) one is
 * a warning. CrossGuard has no hold.
 */
export function pulumiPolicyFindings(violations: readonly PulumiPolicyViolation[]): GatePolicyFindings {
  const where = (v: PulumiPolicyViolation): string => (v.urn ? ` (${v.urn})` : "");
  return {
    denials: violations.filter((v) => v.enforcementLevel === "mandatory").map((v) => ({ rule: crossGuardRule(v), message: `${v.message}${where(v)}` })),
    holds: [],
    warnings: violations.filter((v) => v.enforcementLevel !== "mandatory").map((v) => `${crossGuardRule(v)}: ${v.message}${where(v)}`),
  };
}

/** What an `up` reported at its end, for the step's output. */
export interface PulumiApplySummary {
  /** Counts by op, `same` included, as the engine reports them. */
  resourceChanges: Record<string, number>;
  durationSeconds?: number;
  /** `succeeded`, `failed` or `cancelled`, when the engine says. */
  result?: string;
  maybeCorrupt?: boolean;
  /** plunge's per-resource timings (INTENTIUS/plunge#55), by URN, when the steps carry them. */
  timings?: Record<string, unknown[]>;
}

/** The stream's `summaryEvent`, with plunge's timings when present. Undefined when the stream has no summary. */
export function pulumiStreamSummary(stream: string | readonly PulumiEngineEvent[]): PulumiApplySummary | undefined {
  const events = typeof stream === "string" ? pulumiEngineEvents(stream) : stream;
  const s = events.map((e) => e.summaryEvent).find((x): x is PulumiSummaryEvent => isObject(x));
  const timings: Record<string, unknown[]> = {};
  for (const e of events) {
    const m = e.resOutputsEvent?.metadata ?? e.resourcePreEvent?.metadata;
    if (m?.urn && Array.isArray(m.plungeTimings) && m.plungeTimings.length > 0) timings[m.urn] = m.plungeTimings;
  }
  if (!s) return undefined;
  return {
    resourceChanges: isObject(s.resourceChanges) ? (s.resourceChanges as Record<string, number>) : {},
    ...(typeof s.durationSeconds === "number" ? { durationSeconds: s.durationSeconds } : {}),
    ...(typeof s.result === "string" && s.result ? { result: s.result } : {}),
    ...(s.maybeCorrupt ? { maybeCorrupt: true } : {}),
    ...(Object.keys(timings).length > 0 ? { timings } : {}),
  };
}

/** The first error a stream reported (an error diagnostic or an `errorEvent`), if any. */
export function pulumiStreamError(stream: string | readonly PulumiEngineEvent[]): string | undefined {
  const events = typeof stream === "string" ? pulumiEngineEvents(stream) : stream;
  for (const e of events) {
    if (typeof e.errorEvent?.error === "string" && e.errorEvent.error.trim()) return e.errorEvent.error.trim();
    if (e.diagnosticEvent?.severity === "error" && typeof e.diagnosticEvent.message === "string") return e.diagnosticEvent.message.trim();
  }
  return undefined;
}
