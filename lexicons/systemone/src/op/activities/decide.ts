/**
 * The `decide` Op activity (ws-058, #2740): ask a decision point for one set
 * of inputs, calling the backend its model decider names, and record the
 * answer.
 *
 * The answer is written by core's `askPoint` (`points ask`, #2739), the same
 * path `chant workspace points ask --response` takes. So the chain, the
 * threshold, a model's answer being `proposed` and never `answered`, the reuse
 * of an answer the same point, declaration and inputs already have, and the
 * escalation to people all come from core. This activity adds three things:
 * reading the inputs through the read contract (`../../read-inputs.ts`), the
 * call to a `POST /v1/systemone` backend (`../../backend.ts`), and refusing a
 * misconfigured backend before anything is asked or written.
 *
 * With the backend unreachable, the point's `unreachable` decides: `escalate`
 * (the default) records the question open for people with the reason, and
 * `fail` writes nothing and fails the step.
 *
 * chant's reads never call a model (ws-052): this runs only as an Op step.
 */

import { loadChantConfig } from "@intentius/chant/config";
import { askPoint } from "@intentius/chant/workspace/decide";
import { workspacePoints, type PointView } from "@intentius/chant/workspace/points-cli";
import type { Escalation } from "@intentius/chant/workspace/points";
import { backendSchema, type SystemoneBackend } from "../../config";
import { checkKey, SystemoneConfigError, systemoneAsk, type SystemoneAskOptions, type SystemoneResponse } from "../../backend";
import { readInputs } from "../../read-inputs";

export interface DecideArgs {
  /** The point's name, as its points file declares it. */
  point: string;
  /** Input values by the point's input names, such as `{ "work-item.fits_small": false }`. They win over values read with `read`. */
  inputs?: Record<string, unknown>;
  /** What to read through the read contract, by output: `{ "work-item": "W-002" }` reads work item W-002 for every `work-item.*` input. */
  read?: Record<string, string>;
  /** What the question is about, such as a work item's id. Written to the answer's `constrains`. */
  subject?: string;
  /** The answer kind file, or a declared kind's name. Without it, the declared answer kind whose points file declares the point. */
  kind?: string;
  /** Where the workspace is found. Defaults to the working directory. */
  cwd?: string;
  /** Backends by name, in place of `systemone.backends` in chant.config. */
  backends?: Record<string, SystemoneBackend>;
  /** Ask, but write nothing. */
  dryRun?: boolean;
}

export interface DecideResult {
  /** The answer record's id: the point's name and the first 12 hex digits of the inputs hash. */
  id: string;
  /** The record file, from the repository root. */
  path: string;
  state: "escalated" | "proposed" | "answered";
  /** True until a person answers or confirms. */
  open: boolean;
  /** The answer, or null while the question is escalated. A model's is a proposal. */
  answer: string | boolean | null;
  /** The record was already there, so nothing was asked or written. */
  reused: boolean;
  written: boolean;
  /** The decider that gave the recorded state: table, model or quorum. */
  decider: string;
  /** For a model's answer: the pinned model id, the backend, its confidence and the threshold it met. */
  model: string | null;
  backend: string | null;
  confidence: number | null;
  threshold: number | null;
  /** Each decider that was asked and did not answer, and why. */
  escalations: Escalation[];
  /** Declared inputs the read value did not have. */
  missing: string[];
}

/** Seams a test swaps. */
export interface DecideDeps {
  /** The HTTP call, in place of the global one. */
  transport?: SystemoneAskOptions["transport"];
  env?: NodeJS.ProcessEnv;
  /** The date written as asked_on, YYYY-MM-DD. */
  on?: string;
  onResponse?: (backend: string, response: SystemoneResponse) => void;
}

/** The step failed: what core refused, or a configuration this activity refuses. */
export class DecideError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DecideError";
  }
}

/** The backends the args give, or `systemone.backends` from the chant.config in `cwd`. Each is checked; a literal key is refused. */
async function backendsFor(args: DecideArgs, cwd: string): Promise<Record<string, SystemoneBackend>> {
  let raw: unknown = args.backends;
  if (raw === undefined) {
    const { config } = await loadChantConfig(cwd);
    raw = (config as { systemone?: { backends?: unknown } }).systemone?.backends ?? {};
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new SystemoneConfigError("backends must be an object of backend name to { url, key? }");
  const out: Record<string, SystemoneBackend> = {};
  for (const [name, b] of Object.entries(raw as Record<string, unknown>)) {
    checkKey((b as { key?: unknown } | null)?.key, `backend ${name}'s key`, cwd);
    const parsed = backendSchema.safeParse(b);
    if (!parsed.success) throw new SystemoneConfigError(`backend ${name} is not { url, key?, timeoutMs? }: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(backend)"} ${i.message}`).join("; ")}`);
    out[name] = parsed.data;
  }
  return out;
}

/** The point as `points --json` lists it, or a refusal. */
async function pointFor(args: DecideArgs, cwd: string): Promise<PointView> {
  const doc = await workspacePoints({ cwd, ...(args.kind !== undefined ? { kind: args.kind } : {}) });
  if ("error" in doc) throw new DecideError(doc.error.code, doc.error.message);
  const point = doc.points.find((p) => p.name === args.point);
  if (!point) {
    const bad = doc.sources.find((s) => s.reason);
    throw new DecideError("point-unknown", `no points file declares ${JSON.stringify(args.point)}${bad ? ` (${bad.kind}: ${bad.reason!.message})` : doc.points.length ? ` (the points are ${doc.points.map((p) => p.name).join(", ")})` : ""}`);
  }
  return point;
}

/** Run the activity with its seams. {@link decide} is this with the real ones. */
export async function runDecide(args: DecideArgs, deps: DecideDeps = {}, signal?: AbortSignal): Promise<DecideResult> {
  if (typeof args?.point !== "string" || args.point === "") throw new DecideError("write-usage-invalid", "decide needs the point's name");
  const cwd = args.cwd ?? process.cwd();
  let backends: Record<string, SystemoneBackend>;
  try {
    backends = await backendsFor(args, cwd);
  } catch (err) {
    if (err instanceof SystemoneConfigError) throw new DecideError("backend-invalid", err.message);
    throw err;
  }
  const point = await pointFor(args, cwd);
  // Every model decider's backend is configured, and a brokered key's capability is declared, before anything is asked.
  for (const d of point.deciders) {
    if (d.kind !== "model") continue;
    if (!backends[d.backend]) {
      throw new DecideError("backend-invalid", `${args.point}'s model decider names the backend ${d.backend}, and none is configured (systemone.backends${Object.keys(backends).length ? `: ${Object.keys(backends).join(", ")}` : " is empty"})`);
    }
    try {
      checkKey(backends[d.backend].key, `backend ${d.backend}'s key`, cwd);
    } catch (err) {
      if (err instanceof SystemoneConfigError) throw new DecideError("backend-invalid", err.message);
      throw err;
    }
  }

  let read = { inputs: {} as Record<string, unknown>, missing: [] as string[] };
  if (args.read && Object.keys(args.read).length > 0) {
    try {
      read = await readInputs(point.inputs.map((i) => i.name), args.read, cwd);
    } catch (err) {
      throw new DecideError("point-inputs-invalid", err instanceof Error ? err.message : String(err));
    }
  }
  const inputs = { ...read.inputs, ...(args.inputs ?? {}) };
  const missing = read.missing.filter((m) => !(m in inputs));

  const ask = systemoneAsk({ backends, cwd, ...(deps.transport ? { transport: deps.transport } : {}), ...(deps.env ? { env: deps.env } : {}), ...(signal ? { signal } : {}), ...(deps.onResponse ? { onResponse: deps.onResponse } : {}) });
  const doc = await askPoint({
    cwd,
    point: args.point,
    inputs,
    ...(args.subject !== undefined ? { subject: args.subject } : {}),
    ...(args.kind !== undefined ? { kind: args.kind } : {}),
    ask,
    via: "cli",
    client: { name: "chant-lexicon-systemone decide" },
    ...(deps.on ? { on: deps.on } : {}),
    ...(args.dryRun ? { dryRun: true } : {}),
  });
  if ("error" in doc) throw new DecideError(doc.error.code, `${doc.error.code}: ${doc.error.message}`);
  const q = doc.question;
  const decider = typeof q.decider.kind === "string" ? q.decider.kind : "quorum";
  return {
    id: doc.id,
    path: doc.path,
    state: q.state,
    open: q.open,
    answer: q.answer,
    reused: doc.reused,
    written: doc.written,
    decider,
    model: decider === "model" ? (q.model?.model ?? null) : null,
    backend: decider === "model" ? (q.model?.backend ?? null) : null,
    confidence: q.confidence,
    threshold: q.threshold,
    escalations: q.escalations,
    missing,
  };
}

/**
 * Ask a decision point and record the answer. The Op activity: an answer
 * record is written under the point's answer kind, and the step returns it.
 */
export async function decide(args: DecideArgs, signal?: AbortSignal): Promise<DecideResult> {
  return runDecide(args, {}, signal);
}
