/**
 * `@intentius/chant/otlp` (#4555): chant's OTLP trace exporter, shared by
 * every CI product built on chant. A run's events (the run-event contract,
 * ./run-event.ts) become one trace: a span for the run, one per wave,
 * component and phase, one per step, and one per resource a lexicon timed.
 * The trace goes out as OTLP/JSON over HTTP with Node's `fetch`, in one batch
 * when the run settles. No OpenTelemetry SDK is loaded.
 *
 * Off unless an endpoint is set. It reads the standard variables:
 *
 *   OTEL_EXPORTER_OTLP_ENDPOINT          base URL; /v1/traces is added
 *   OTEL_EXPORTER_OTLP_TRACES_ENDPOINT   the traces URL, used as given
 *   OTEL_EXPORTER_OTLP_HEADERS           k=v,k2=v2 on every request (and the traces one)
 *   OTEL_TRACES_EXPORTER                 `none` turns traces off
 *   OTEL_SDK_DISABLED=true               turns them off
 *   OTEL_SERVICE_NAME, OTEL_RESOURCE_ATTRIBUTES
 *   TRACEPARENT                          the run's trace joins it
 *
 * The product prefix. Span attributes chant writes carry the product's name
 * as their namespace (`chant.*`, `terragucci.*`, `plywood.*`), from the
 * product's words (`@intentius/chant/ci-product`, #4550): a product's bin
 * sets its words, and the exporter names attributes with them. A product
 * may also pass `prefix` to {@link configureOtlp} once, before it calls
 * chant. Keys that already carry a namespace chant does not own (OpenTelemetry
 * semantic conventions such as `vcs.ref.head.revision`) are written as given.
 *
 * Engine facts. A capability can say what it knows about one apply
 * ({@link CapabilityTraceFacts}, `Capability.traceFacts`): attributes such
 * as the root or stack, the binary and resource counts, and spans for the
 * resources it timed. They join the step's span under the same prefix.
 *
 * This module imports only the product words and the run-event types, so a
 * product bundle that loads it pulls in no CLI.
 */

import { randomBytes } from "node:crypto";
import { activeProductWords } from "./ci-product-words";
import { CHANT_VERSION } from "./chant-version";
import { NEXT_RELEASE } from "./release-floors";
import type { RunEventBody, RunEventRun } from "./run-event";

/** The first chant with the OTLP exporter, op-wave run events and the product tool hook (#4555). */
export const OTLP_EXPORTER_FLOOR = NEXT_RELEASE;

export type OtlpAttrValue = string | number | boolean;
export type OtlpAttrs = Record<string, OtlpAttrValue | undefined>;

/** Where one signal goes. */
export interface OtlpTarget {
  url: string;
  headers: Record<string, string>;
}

/** The exporter's settings, from the environment. */
export interface OtlpConfig {
  /** Absent when traces are off although the environment named an endpoint; `skipped` says why. */
  traces?: OtlpTarget;
  /** Resource attributes: `service.name` and OTEL_RESOURCE_ATTRIBUTES. */
  resource: OtlpAttrs;
  /** The attribute namespace: the product's name. */
  prefix: string;
  /** Why traces are off although an endpoint is set. */
  skipped: string[];
  /** TRACEPARENT, when the environment gave one. */
  traceparent?: string;
}

/** `fetch`, as the exporter calls it. A test passes its own. */
export type OtlpFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** A product name as an attribute namespace: the words' `product` is already `[a-z0-9-]`. */
const PREFIX = /^[a-z0-9][a-z0-9_-]*$/;

/** `k=v,k2=v2`, values percent-decoded, as OTEL_*_HEADERS and OTEL_RESOURCE_ATTRIBUTES write them. */
export function parseOtlpPairs(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (text ?? "").split(",")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    let v = part.slice(i + 1).trim();
    try {
      v = decodeURIComponent(v);
    } catch {
      // kept as written
    }
    if (k) out[k] = v;
  }
  return out;
}

/** `k=v,k2=v2`, values percent-encoded. */
export function formatOtlpPairs(pairs: Record<string, string>): string {
  return Object.entries(pairs).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join(",");
}

function tracesTarget(env: NodeJS.ProcessEnv, skipped: string[]): OtlpTarget | undefined {
  const exporter = env.OTEL_TRACES_EXPORTER;
  if (exporter !== undefined && exporter.trim() !== "" && !exporter.split(",").map((s) => s.trim()).includes("otlp")) return undefined;
  const own = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  const url = own || (base ? `${base.replace(/\/+$/, "")}/v1/traces` : undefined);
  if (!url) return undefined;
  const protocol = env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? env.OTEL_EXPORTER_OTLP_PROTOCOL;
  if (protocol === "grpc") {
    skipped.push("traces: chant sends OTLP over HTTP and the protocol is grpc; point it at the collector's HTTP port");
    return undefined;
  }
  if (!/^https?:\/\//.test(url)) {
    skipped.push(`traces: ${url} is not an http or https URL`);
    return undefined;
  }
  return { url, headers: { ...parseOtlpPairs(env.OTEL_EXPORTER_OTLP_HEADERS), ...parseOtlpPairs(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS) } };
}

/**
 * The exporter's settings from `env`, or undefined when no endpoint is set
 * or the SDK is disabled. `prefix` defaults to the active product's name,
 * and `service.name` to OTEL_SERVICE_NAME, then OTEL_RESOURCE_ATTRIBUTES,
 * then the prefix.
 */
export function otlpFromEnv(env: NodeJS.ProcessEnv = process.env, opts: { prefix?: string } = {}): OtlpConfig | undefined {
  if (env.OTEL_SDK_DISABLED?.trim().toLowerCase() === "true") return undefined;
  const skipped: string[] = [];
  const traces = tracesTarget(env, skipped);
  if (!traces && skipped.length === 0) return undefined;
  const prefix = opts.prefix ?? activeProductWords().product;
  if (!PREFIX.test(prefix)) throw new Error(`the OTLP attribute prefix ${JSON.stringify(prefix)} is not a product name ([a-z0-9][a-z0-9_-]*)`);
  const resource: OtlpAttrs = { ...parseOtlpPairs(env.OTEL_RESOURCE_ATTRIBUTES) };
  resource["service.name"] = env.OTEL_SERVICE_NAME?.trim() || resource["service.name"] || prefix;
  const traceparent = env.TRACEPARENT?.trim();
  return { ...(traces ? { traces } : {}), resource, prefix, skipped, ...(traceparent ? { traceparent } : {}) };
}

/**
 * `attrs` under `prefix`: a key is written as `<prefix>.<key>` unless it
 * already starts with `<prefix>.` or with a namespace from
 * {@link OTLP_PASS_THROUGH}. Undefined values are dropped.
 */
export function prefixedAttrs(prefix: string, attrs: OtlpAttrs | undefined): OtlpAttrs {
  const out: OtlpAttrs = {};
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined) continue;
    const kept = k.startsWith(`${prefix}.`) || OTLP_PASS_THROUGH.some((ns) => k.startsWith(ns));
    out[kept ? k : `${prefix}.${k}`] = v;
  }
  return out;
}

/** OpenTelemetry semantic-convention namespaces written as given, never under the product's prefix. */
export const OTLP_PASS_THROUGH: readonly string[] = ["service.", "deployment.", "vcs.", "cicd.", "error.", "code.", "process.", "cloud."];

// ── spans ────────────────────────────────────────────────────────────────────

/** A time in Unix nanoseconds, from milliseconds. */
export const nanosOf = (ms: number): bigint => BigInt(Math.round(ms)) * 1_000_000n;

export interface OtlpSpanEvent {
  name: string;
  /** Unix nanoseconds. */
  time: bigint;
  attributes: OtlpAttrs;
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  /** 1 internal, 3 client (a process or provider call the run made). */
  kind: 1 | 3;
  /** Unix nanoseconds. */
  start: bigint;
  end?: bigint;
  attributes: OtlpAttrs;
  error?: string;
  events?: OtlpSpanEvent[];
}

const hex = (bytes: number): string => randomBytes(bytes).toString("hex");

/** `00-<trace>-<span>-<flags>`, or undefined when it is not one. */
export function parseTraceparent(text: string | undefined): { traceId: string; spanId: string } | undefined {
  const m = /^[\da-f]{2}-([\da-f]{32})-([\da-f]{16})-[\da-f]{2}$/.exec((text ?? "").trim().toLowerCase());
  if (!m || /^0+$/.test(m[1]!) || /^0+$/.test(m[2]!)) return undefined;
  return { traceId: m[1]!, spanId: m[2]! };
}

/** One run's trace. Spans are kept in memory and sent once. */
export class OtlpTrace {
  readonly traceId: string;
  /** The span TRACEPARENT named, which the run's first span hangs under. */
  readonly parent?: string;
  readonly spans: OtlpSpan[] = [];
  private readonly now: () => number;

  constructor(traceparent?: string, opts: { now?: () => number } = {}) {
    const p = parseTraceparent(traceparent);
    this.traceId = p?.traceId ?? hex(16);
    if (p) this.parent = p.spanId;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Open a span under `parent` (or the TRACEPARENT span), at `atMs` or now. */
  start(name: string, parent?: OtlpSpan, attributes: OtlpAttrs = {}, opts: { kind?: 1 | 3; atMs?: number } = {}): OtlpSpan {
    const span: OtlpSpan = { traceId: this.traceId, spanId: hex(8), name, kind: opts.kind ?? 1, start: nanosOf(opts.atMs ?? this.now()), attributes: { ...attributes } };
    const parentId = parent?.spanId ?? this.parent;
    if (parentId) span.parentSpanId = parentId;
    this.spans.push(span);
    return span;
  }

  /** Close `span` at `atMs` or now. A closed span stays as it was. */
  end(span: OtlpSpan, attributes: OtlpAttrs = {}, error?: string, atMs?: number): void {
    if (span.end !== undefined) return;
    span.end = nanosOf(atMs ?? this.now());
    if (span.end < span.start) span.end = span.start;
    Object.assign(span.attributes, attributes);
    if (error) span.error = error;
  }

  /** An event inside `span`, at `at` (an ISO time) or now. */
  event(span: OtlpSpan, name: string, attributes: OtlpAttrs = {}, at?: string): void {
    const ms = at ? Date.parse(at) : NaN;
    (span.events ??= []).push({ name, time: nanosOf(Number.isFinite(ms) ? ms : this.now()), attributes: { ...attributes } });
  }

  /** The W3C header that makes `span` the parent of what a process sends. */
  traceparent(span: OtlpSpan): string {
    return `00-${this.traceId}-${span.spanId}-01`;
  }
}

function attrList(attrs: OtlpAttrs): { key: string; value: Record<string, unknown> }[] {
  return Object.entries(attrs)
    .filter((e): e is [string, OtlpAttrValue] => e[1] !== undefined)
    .map(([key, v]) => ({
      key,
      value: typeof v === "boolean" ? { boolValue: v } : typeof v === "number" ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v }) : { stringValue: v },
    }));
}

/** The OTLP/JSON body for a trace's spans. The scope is chant's, whichever product prefixes the attributes. */
export function otlpTracesBody(spans: readonly OtlpSpan[], resource: OtlpAttrs, version: string = CHANT_VERSION): unknown {
  return {
    resourceSpans: [{
      resource: { attributes: attrList(resource) },
      scopeSpans: [{
        scope: { name: "chant", version },
        spans: spans.map((s) => ({
          traceId: s.traceId,
          spanId: s.spanId,
          ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
          name: s.name,
          kind: s.kind,
          startTimeUnixNano: String(s.start),
          endTimeUnixNano: String(s.end ?? s.start),
          attributes: attrList(s.attributes),
          ...(s.events?.length ? { events: s.events.map((e) => ({ timeUnixNano: String(e.time), name: e.name, attributes: attrList(e.attributes) })) } : {}),
          status: s.error ? { code: 2, message: s.error } : { code: 1 },
        })),
      }],
    }],
  };
}

/** POST one OTLP/JSON body. Returns the problem, or undefined when the collector took it. Never throws. */
export async function sendOtlp(target: OtlpTarget, body: unknown, fetchFn: OtlpFetch = fetch as unknown as OtlpFetch): Promise<string | undefined> {
  try {
    const res = await fetchFn(target.url, {
      method: "POST",
      headers: { ...target.headers, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return `${target.url} answered ${res.status}: ${(await res.text()).slice(0, 200)}`;
    return undefined;
  } catch (e) {
    return `${target.url}: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ── engine facts ─────────────────────────────────────────────────────────────

/** One timed piece of an apply, such as one resource's provider call or record write. */
export interface CapabilityTraceSpan {
  /** The span's name, such as the resource's URN or address. */
  name: string;
  /** When it started, ISO-8601. */
  startedAt: string;
  durationMs: number;
  /** Written under the product's prefix. */
  attributes?: Record<string, OtlpAttrValue>;
  failed?: boolean;
  /** Spans inside this one, such as each call one resource made. */
  children?: CapabilityTraceSpan[];
}

/**
 * What a capability knows about one apply, for its step's span and run
 * record (#4555): engine facts as attributes (the root or stack, the
 * binary, resource counts) and the resources it timed. Keys are written
 * under the product's prefix.
 */
export interface CapabilityTraceFacts {
  attributes?: Record<string, OtlpAttrValue>;
  spans?: CapabilityTraceSpan[];
}

// ── the exporter, configured once ────────────────────────────────────────────

/** The exporter a process uses: its settings and how it sends. */
export interface OtlpExporter {
  readonly config: OtlpConfig;
  /** A new trace, under TRACEPARENT when the environment gave one. */
  trace(): OtlpTrace;
  /** Send a trace's spans. Returns the problem, or undefined. Never throws. */
  send(trace: OtlpTrace): Promise<string | undefined>;
}

let configured: { exporter: OtlpExporter | undefined } | undefined;

/** An exporter over `config`. */
export function createOtlpExporter(config: OtlpConfig, fetchFn?: OtlpFetch): OtlpExporter {
  return {
    config,
    trace: () => new OtlpTrace(config.traceparent),
    async send(trace) {
      if (!config.traces) return config.skipped.join("; ") || undefined;
      if (trace.spans.length === 0) return undefined;
      return sendOtlp(config.traces, otlpTracesBody(trace.spans, config.resource), fetchFn);
    },
  };
}

/**
 * Configure the process's exporter once: a product's bin calls this before
 * it calls chant, with its prefix when its words are not set yet. Returns
 * the exporter, or undefined when the environment names no endpoint. A
 * later call replaces the earlier one.
 */
export function configureOtlp(opts: { prefix?: string; env?: NodeJS.ProcessEnv; fetch?: OtlpFetch } = {}): OtlpExporter | undefined {
  const config = otlpFromEnv(opts.env ?? process.env, opts.prefix !== undefined ? { prefix: opts.prefix } : {});
  configured = { exporter: config ? createOtlpExporter(config, opts.fetch) : undefined };
  return configured.exporter;
}

/** The process's exporter: the configured one, else one from the environment with the active product's prefix. */
export function activeOtlp(): OtlpExporter | undefined {
  if (configured) return configured.exporter;
  const config = otlpFromEnv(process.env);
  return config ? createOtlpExporter(config) : undefined;
}

/** Forget the configured exporter, so the next {@link activeOtlp} reads the environment again. For tests. */
export function resetOtlp(): void {
  configured = undefined;
}

// ── run events as a trace ────────────────────────────────────────────────────

type SettleStatus = "ok" | "failed" | "gated" | "waiting" | "skipped" | "cached" | "blocked" | "already-applied";

/**
 * A run's trace, built from its run events as they are emitted (#4555). Hand
 * {@link sink} to the run's stream; {@link annotate} a step with what its
 * capability knew; {@link flush} once the run settles.
 *
 * The run is the root span (under TRACEPARENT when set). A component run's
 * waves and components, and every run's phases, are spans below it, and each
 * step is a span in its phase. A gate a step waits at, or was resolved by, is
 * an event on the step's span. Every attribute chant writes is under the
 * product's prefix.
 */
export class RunEventTrace {
  readonly trace: OtlpTrace;
  readonly prefix: string;
  private root?: OtlpSpan;
  private readonly waves = new Map<number, OtlpSpan>();
  private readonly components = new Map<string, OtlpSpan>();
  private readonly phases = new Map<string, OtlpSpan>();
  private readonly steps = new Map<string, OtlpSpan>();
  private readonly now: () => number;
  private readonly exporter?: OtlpExporter;

  constructor(
    readonly run: RunEventRun,
    opts: { exporter?: OtlpExporter; trace?: OtlpTrace; prefix?: string; now?: () => number } = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.trace = opts.trace ?? opts.exporter?.trace() ?? new OtlpTrace(undefined, { now: this.now });
    this.prefix = opts.prefix ?? opts.exporter?.config.prefix ?? activeProductWords().product;
    this.exporter = opts.exporter;
  }

  private attrs(a: OtlpAttrs): OtlpAttrs {
    return prefixedAttrs(this.prefix, a);
  }

  private rootSpan(): OtlpSpan {
    if (!this.root) {
      const { runId, kind, name, gitSha, runtime, runOrigin } = this.run;
      this.root = this.trace.start(`${kind} ${name}`, undefined, {
        ...this.attrs({ "run.id": runId, "run.kind": kind, "run.name": name, "run.runtime": runtime, "run.forge": runOrigin.forge }),
        ...(gitSha ? { "vcs.ref.head.revision": gitSha } : {}),
      }, { atMs: this.now() });
    }
    return this.root;
  }

  private phaseKey(component: string | null, phase: string): string {
    return `${component ?? ""}\u0000${phase}`;
  }

  private stepKey(component: string | null, phase: string, step: string, index?: number): string {
    return `${component ?? ""}\u0000${phase}\u0000${step}\u0000${index ?? ""}`;
  }

  private phaseSpan(component: string | null, phase: string): OtlpSpan {
    const key = this.phaseKey(component, phase);
    let span = this.phases.get(key);
    if (!span) {
      const parent = (component !== null ? this.components.get(component) : undefined) ?? this.rootSpan();
      span = this.trace.start(phase, parent, this.attrs({ phase, ...(component !== null ? { component } : {}) }));
      this.phases.set(key, span);
    }
    return span;
  }

  private status(span: OtlpSpan, status: SettleStatus, error?: string, atMs?: number): void {
    this.trace.end(span, this.attrs({ status }), status === "failed" ? error ?? "failed" : undefined, atMs);
  }

  /** Take one run event. Hand this to the run's stream as a sink. */
  readonly sink = (body: RunEventBody): void => {
    switch (body.type) {
      case "run-start":
        this.rootSpan();
        return;
      case "wave-start":
        this.waves.set(body.wave, this.trace.start(`wave ${body.wave}`, this.rootSpan(), this.attrs({ wave: body.wave, components: body.components.join(",") })));
        return;
      case "wave-settle": {
        const span = this.waves.get(body.wave);
        if (span) this.status(span, body.status);
        return;
      }
      case "component-start":
        this.components.set(body.component, this.trace.start(body.component, this.waves.get(body.wave) ?? this.rootSpan(), this.attrs({ component: body.component, wave: body.wave })));
        return;
      case "component-settle": {
        let span = this.components.get(body.component);
        // A blocked or already-applied component never started: a zero-length span says it was there.
        if (!span) span = this.trace.start(body.component, this.waves.get(body.wave) ?? this.rootSpan(), this.attrs({ component: body.component, wave: body.wave }));
        this.status(span, body.status);
        if (body.blockedBy) span.attributes[`${this.prefix}.blocked_by`] = body.blockedBy;
        return;
      }
      case "phase-start":
        this.phaseSpan(body.component, body.phase);
        return;
      case "phase-settle":
        this.status(this.phaseSpan(body.component, body.phase), body.status);
        return;
      case "step-start": {
        const key = this.stepKey(body.component, body.phase, body.step, body.index);
        this.steps.set(key, this.trace.start(body.step, this.phaseSpan(body.component, body.phase), this.attrs({ step: body.step, phase: body.phase })));
        return;
      }
      case "step-settle": {
        const key = this.stepKey(body.component, body.phase, body.step, body.index);
        let span = this.steps.get(key);
        const end = this.now();
        if (!span) {
          // A step settled with no start (skipped, or timed elsewhere): it ran for its duration, up to now.
          span = this.trace.start(body.step, this.phaseSpan(body.component, body.phase), this.attrs({ step: body.step, phase: body.phase }), { atMs: end - (body.durationMs ?? 0) });
          this.steps.set(key, span);
        }
        if (body.skip) span.attributes[`${this.prefix}.skip`] = body.skip;
        if (body.message) span.attributes[`${this.prefix}.message`] = body.message;
        this.status(span, body.status, body.error, end);
        return;
      }
      case "gate-waiting": {
        const span = this.steps.get(this.stepKey(body.component, body.phase, body.step, body.index)) ?? this.phaseSpan(body.component, body.phase);
        this.trace.event(span, "gate-waiting", this.attrs({ "gate.op": body.op, ...(body.gate ? { gate: body.gate } : {}), ...(body.point ? { "gate.point": body.point } : {}) }));
        return;
      }
      case "gate-resolved": {
        const span = this.steps.get(this.stepKey(body.component, body.phase, body.step, body.index)) ?? this.phaseSpan(body.component, body.phase);
        this.trace.event(span, "gate-resolved", this.attrs({ "gate.op": body.op, gate: body.gate, "gate.resolved_by": body.resolvedBy, ...(body.via ? { "gate.via": body.via } : {}) }), body.resolvedAt);
        return;
      }
      case "run-settle": {
        const root = this.rootSpan();
        const end = this.now();
        // Anything still open closes with the run.
        for (const span of this.trace.spans) if (span !== root && span.end === undefined) this.trace.end(span, {}, undefined, end);
        this.status(root, body.status, body.failure?.reason ?? body.error, end);
        if (body.failure) Object.assign(root.attributes, this.attrs({ "failure.code": body.failure.code, ...(body.failure.exitCode !== undefined ? { "failure.exit_code": body.failure.exitCode } : {}) }));
        return;
      }
    }
  };

  /**
   * Add a capability's facts to a step's span: its attributes, and a child
   * span per timed piece. A step not seen yet gets a span in its phase.
   */
  annotate(at: { component?: string | null; phase: string; step: string; index?: number }, facts: CapabilityTraceFacts): void {
    const component = at.component ?? null;
    const key = this.stepKey(component, at.phase, at.step, at.index);
    let span = this.steps.get(key);
    if (!span) {
      span = this.trace.start(at.step, this.phaseSpan(component, at.phase), this.attrs({ step: at.step, phase: at.phase }));
      this.steps.set(key, span);
    }
    Object.assign(span.attributes, this.attrs(facts.attributes ?? {}));
    for (const s of facts.spans ?? []) this.timed(s, span);
  }

  private timed(s: CapabilityTraceSpan, parent: OtlpSpan): void {
    const started = Date.parse(s.startedAt);
    if (!Number.isFinite(started) || !Number.isFinite(s.durationMs) || s.durationMs < 0) return;
    const span = this.trace.start(s.name, parent, this.attrs(s.attributes ?? {}), { kind: 3, atMs: started });
    this.trace.end(span, {}, s.failed ? "failed" : undefined, started + s.durationMs);
    for (const c of s.children ?? []) this.timed(c, span);
  }

  /** Send the trace through the exporter it was made with. Returns the problem, or undefined. Never throws. */
  async flush(): Promise<string | undefined> {
    if (!this.exporter) return undefined;
    return this.exporter.send(this.trace);
  }
}
