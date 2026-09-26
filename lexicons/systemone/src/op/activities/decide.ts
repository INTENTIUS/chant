/**
 * The `decide` Op activity (ws-058, #2740): ask a decision point for one set
 * of inputs, calling the backend its model decider names, and record the
 * answer.
 *
 * The point is asked through core's `askPointInRun` (#2749), which writes the
 * answer with `askPoint` (`points ask`, #2739), the same path `chant workspace
 * points ask --response` takes. So the chain, the threshold, a model's answer
 * being `proposed` and never `answered`, the reuse of an answer the same point,
 * declaration and inputs already have, the escalation to people, and what an
 * open question does to the run all come from core:
 *
 * - an answered question (a table row, or a person) is the step's result, and
 *   the Op goes on;
 * - an escalated or proposed question is open, so the step throws core's
 *   `PointWait` and the run ends `waiting`. A person answers with `points
 *   answer` or through hud, and the next run reads the answer from the record.
 *
 * This activity adds three things: reading the inputs through the read
 * contract (`../../read-inputs.ts`), the call to a `POST /v1/systemone` backend
 * (`../../backend.ts`), and refusing a misconfigured backend before anything is
 * asked or written.
 *
 * With the backend unreachable, the point's `unreachable` decides: `escalate`
 * (the default) records the question open for people with the reason, and
 * `fail` writes nothing and fails the step.
 *
 * In a steward's turn the model call goes through the broker (#2749): core
 * makes it only through a capability the steward declares, and a backend whose
 * key is an environment variable is not called, since that key would be a
 * credential the steward holds.
 *
 * chant's reads never call a model (ws-052): this runs only as an Op step.
 */

import { loadChantConfig } from "@intentius/chant/config";
import { askPointInRun, brokeredModelAsk, currentStewardTurn, isPointWait, type BrokeredModelAsk } from "@intentius/chant/op";
import { askPoint, type QuestionView } from "@intentius/chant/workspace/decide";
import { workspacePoints, type PointView } from "@intentius/chant/workspace/points-cli";
import type { Escalation } from "@intentius/chant/workspace/points";
import { backendSchema, type SystemoneBackend } from "../../config";
import { brokeredCapability, checkKey, SystemoneConfigError, systemoneAsk, type SystemoneAskOptions, type SystemoneResponse } from "../../backend";
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
  /** Ask, but write nothing, and return the question whatever its state: an open one does not stop the run. */
  dryRun?: boolean;
}

export interface DecideResult {
  /** The answer record's id: the point's name and the first 12 hex digits of the inputs hash. */
  id: string;
  /** The record file, from the repository root. */
  path: string;
  /** `answered`, unless this was a dry run, which returns a question in any state. */
  state: "escalated" | "proposed" | "answered";
  open: boolean;
  /** The answer, or null while the question is escalated. */
  answer: string | boolean | null;
  /** The decider that gave the recorded state: table, model (a proposal, or one a person confirmed) or quorum. */
  decider: string;
  /** For a model's answer: the pinned model id, the backend, its confidence and the threshold it met. */
  model: string | null;
  backend: string | null;
  confidence: number | null;
  threshold: number | null;
  /** The people who answered, when people did. */
  answeredBy: string[];
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

function configError<T>(f: () => T): T {
  try {
    return f();
  } catch (err) {
    if (err instanceof SystemoneConfigError) throw new DecideError("backend-invalid", err.message);
    throw err;
  }
}

function result(q: QuestionView, missing: string[]): DecideResult {
  const decider = typeof q.decider.kind === "string" ? q.decider.kind : "quorum";
  const byModel = decider === "model";
  return {
    id: q.id,
    path: q.path,
    state: q.state,
    open: q.open,
    answer: q.answer,
    decider,
    model: byModel ? (q.model?.model ?? null) : null,
    backend: byModel ? (q.model?.backend ?? null) : null,
    confidence: byModel ? q.confidence : null,
    threshold: byModel ? q.threshold : null,
    answeredBy: q.answeredBy,
    escalations: q.escalations,
    missing,
  };
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

  // Every model decider's backend is configured, and a brokered key's
  // capability is declared with a broker, before anything is asked. The first
  // brokered one names the capability a steward's call goes through.
  let via: { capability: string; broker: string } | undefined;
  for (const d of point.deciders) {
    if (d.kind !== "model") continue;
    const backend = backends[d.backend];
    if (!backend) {
      throw new DecideError("backend-invalid", `${args.point}'s model decider names the backend ${d.backend}, and none is configured (systemone.backends${Object.keys(backends).length ? `: ${Object.keys(backends).join(", ")}` : " is empty"})`);
    }
    configError(() => checkKey(backend.key, `backend ${d.backend}'s key`, cwd));
    if (via === undefined && backend.key && "capability" in backend.key) {
      const key = backend.key;
      via = { capability: key.capability, broker: configError(() => brokeredCapability(key, cwd)).broker };
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

  const call = systemoneAsk({ backends, cwd, ...(deps.transport ? { transport: deps.transport } : {}), ...(deps.env ? { env: deps.env } : {}), ...(signal ? { signal } : {}), ...(deps.onResponse ? { onResponse: deps.onResponse } : {}) });
  const turn = currentStewardTurn();
  const ask: BrokeredModelAsk = async (request) => {
    const key = backends[request.backend]?.key;
    if (turn && key && !("capability" in key)) {
      throw new Error(`in the steward ${turn.steward}'s turn a model call goes through the broker, and backend ${request.backend}'s key is the environment variable ${key.env}, a credential the steward would hold`);
    }
    return call(request);
  };
  const common = {
    cwd,
    point: args.point,
    inputs,
    ...(args.subject !== undefined ? { subject: args.subject } : {}),
    ...(args.kind !== undefined ? { kind: args.kind } : {}),
    ...(deps.on ? { on: deps.on } : {}),
  };

  if (args.dryRun) {
    const doc = await askPoint({
      ...common,
      ask: await brokeredModelAsk(ask, { ...(via ? via : {}), turn: turn ?? null, cwd }),
      ...(turn ? { steward: { name: turn.steward, ...(turn.run ? { run: turn.run } : {}) } } : { client: { name: "chant-lexicon-systemone decide" } }),
      dryRun: true,
    });
    if ("error" in doc) throw new DecideError(doc.error.code, `${doc.error.code}: ${doc.error.message}`);
    return result(doc.question, missing);
  }

  try {
    const { question } = await askPointInRun({ ...common, ask, ...(via ? { capability: via.capability, broker: via.broker } : {}), turn: turn ?? null });
    return result(question, missing);
  } catch (err) {
    // An open question is not a failure: the run waits on it (#2749).
    if (isPointWait(err)) throw err;
    const coded = err instanceof Error ? /^decision point [^:]+: ([a-z0-9-]+): /.exec(err.message) : null;
    if (coded) throw new DecideError(coded[1], err instanceof Error ? err.message : String(err));
    throw err;
  }
}

/**
 * Ask a decision point and record the answer. The Op activity: an answered
 * question is the step's result, and an open one stops the run `waiting`.
 */
export async function decide(args: DecideArgs, signal?: AbortSignal): Promise<DecideResult> {
  return runDecide(args, {}, signal);
}
