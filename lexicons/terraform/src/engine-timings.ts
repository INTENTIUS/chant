/**
 * Per-root engine timings for `terraform-apply` (chant#4887): how long each
 * root's init, plan and apply ran, and the engine's own spans, read into the
 * slowest resources and provider calls, provider start-up and state lock
 * waits, for a plain wave and a composed one.
 *
 * {@link engineTimings} gives a {@link TerraformCommandHook} to pass as
 * `terraformApplyCapabilityWith({ onCommand })` (chant#4865). It listens on
 * a loopback port for the run and points each command's OTLP trace exporter
 * at it (`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`), with a header naming the
 * root and the command the spans came from. OpenTofu and choudoufu export
 * OTLP/HTTP protobuf, so the receiver decodes the few protobuf messages a
 * trace export holds; OTLP/JSON is read too. A binary that sends no spans
 * (Terraform) still gets each command timed. With `forward`, each batch also
 * goes on unchanged to the product's own collector.
 *
 * A composed group's commands (`terraform.compose`) run once for all its
 * members, so each member root gets the group's times and spans, and its
 * timings name the members it ran with. The run's slowest resources count a
 * group once.
 *
 * Lifted from terragucci's `report/spans.ts` (the decoder, `SpanReceiver`,
 * `rootTimings`, `runTimings`, `duration`) and the timing half of
 * `report/observe.ts` (`StageObserver.commandHook`, `addTimings`), so
 * terragucci deletes its copy. No OpenTelemetry SDK and no protobuf library.
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { gunzipSync, inflateSync } from "node:zlib";
import type { TerraformCommand, TerraformCommandHook, TerraformCommandResult } from "./op/command-hook";

/** One resource instance's time, from its plan or apply span. */
export interface EngineResourceTiming {
  address: string;
  type?: string;
  action?: string;
  /** The provider instance it is planned with. */
  provider?: string;
  ms: number;
  /** The part of it spent refreshing the resource. */
  refresh_ms?: number;
}

/** One provider RPC's time. */
export interface EngineProviderCall {
  /** The RPC method: `PlanResourceChange`, `ReadResource`, `GetProviderSchema`... */
  method: string;
  provider?: string;
  type?: string;
  /** The resource instance it was made for, when it was made for one. */
  address?: string;
  ms: number;
}

/** A choudoufu aggregate span: resources or calls summed past its span budget. */
export interface EngineAggregate {
  /** The name of the spans it stands for, such as `Plan resource instance changes`, or `other`. */
  of: string;
  /** `resource_instance` or `provider_call`. */
  kind?: string;
  type?: string;
  provider?: string;
  method?: string;
  count: number;
  /** How many of them also have a span of their own. */
  detailed: number;
  /** Their total time. */
  ms: number;
  max_ms: number;
  /** The slowest member: an address, or a resource type. */
  slowest?: string;
  /** For `other`: how many groups it folds. */
  groups?: number;
}

/** A wait for a state lock, from the engine's `State lock wait` span. */
export interface EngineLockWait {
  backend?: string;
  operation?: string;
  attempts?: number;
  ms: number;
}

/** One root's timings. The field names are the ones terragucci's report has written since its schema's minor 3. */
export interface EngineRootTimings {
  /** The root's engine commands together: init, plan and show, and on an apply the apply and output. */
  seconds: number;
  /** The engine's plan runs alone. Absent when the root never reached one. */
  plan_seconds?: number;
  /** The engine's apply runs alone. Absent when the root was not applied. */
  apply_seconds?: number;
  /**
   * Where the times come from: `binary`, each run of the binary was timed;
   * `terragrunt`, Terragrunt ran the binary and its run report gives the
   * unit's times. Absent means `binary`.
   */
  source?: "binary" | "terragrunt";
  /** How many spans the binary sent for the commands counted. */
  spans: number;
  /** `resources`: a span per resource instance; `aggregate`: summed by type only; `none`: nothing per resource. */
  detail: "resources" | "aggregate" | "none";
  /** Why the lists are empty or partial. */
  note?: string;
  /** The slowest resource instances, slowest first. */
  resources: EngineResourceTiming[];
  provider_calls: EngineProviderCall[];
  /** Provider start-up, by provider. */
  provider_init: { provider: string; count: number; ms: number; max_ms: number }[];
  /** Waits for a state lock. */
  lock_waits: EngineLockWait[];
  aggregates: EngineAggregate[];
}

/** A run's slowest roots and resources. */
export interface EngineRunTimings {
  /** Every timed root, slowest first. */
  roots: { root: string; seconds: number; plan_seconds?: number; apply_seconds?: number; source?: EngineRootTimings["source"]; detail: EngineRootTimings["detail"] }[];
  /** The slowest resource instances across the run. */
  resources: { root: string; address: string; type?: string; ms: number }[];
  /** Why the run has no per-root timings, when it has none. */
  note?: string;
}

export type SpanValue = string | number | boolean;

/** One span as the binary sent it, with only what the report reads. */
export interface CollectedSpan {
  spanId: string;
  parentSpanId?: string;
  name: string;
  start: bigint;
  end: bigint;
  attributes: Record<string, SpanValue>;
  error?: boolean;
}

// OTLP protobuf

interface Field {
  no: number;
  wire: number;
  int?: bigint;
  bytes?: Buffer;
}

/** The fields of one protobuf message. Throws on a truncated or malformed one. */
function* fields(buf: Buffer): Generator<Field> {
  let pos = 0;
  const varint = (): bigint => {
    let out = 0n;
    for (let shift = 0n; ; shift += 7n) {
      if (pos >= buf.length) throw new Error("truncated varint");
      const b = buf[pos++];
      out |= BigInt(b & 0x7f) << shift;
      if (b < 0x80) return out;
      if (shift > 63n) throw new Error("varint too long");
    }
  };
  const take = (n: number): Buffer => {
    if (pos + n > buf.length) throw new Error("truncated field");
    const b = buf.subarray(pos, pos + n);
    pos += n;
    return b;
  };
  while (pos < buf.length) {
    const key = Number(varint());
    const no = key >>> 3;
    const wire = key & 7;
    if (wire === 0) yield { no, wire, int: varint() };
    else if (wire === 1) yield { no, wire, bytes: take(8) };
    else if (wire === 2) yield { no, wire, bytes: take(Number(varint())) };
    else if (wire === 5) yield { no, wire, bytes: take(4) };
    else throw new Error(`unsupported wire type ${wire}`);
  }
}

/** opentelemetry.proto.common.v1.AnyValue, scalars only. */
function anyValue(buf: Buffer): SpanValue | undefined {
  for (const f of fields(buf)) {
    if (f.no === 1 && f.bytes) return f.bytes.toString("utf-8");
    if (f.no === 2 && f.int !== undefined) return f.int !== 0n;
    if (f.no === 3 && f.int !== undefined) return Number(BigInt.asIntN(64, f.int));
    if (f.no === 4 && f.bytes) return f.bytes.readDoubleLE(0);
  }
  return undefined;
}

function keyValue(buf: Buffer, into: Record<string, SpanValue>): void {
  let key: string | undefined;
  let value: SpanValue | undefined;
  for (const f of fields(buf)) {
    if (f.no === 1 && f.bytes) key = f.bytes.toString("utf-8");
    else if (f.no === 2 && f.bytes) value = anyValue(f.bytes);
  }
  if (key !== undefined && value !== undefined) into[key] = value;
}

function protoSpan(buf: Buffer): CollectedSpan | undefined {
  const s: Partial<CollectedSpan> & { attributes: Record<string, SpanValue> } = { attributes: {} };
  for (const f of fields(buf)) {
    if (!f.bytes) continue;
    if (f.no === 2) s.spanId = f.bytes.toString("hex");
    else if (f.no === 4 && f.bytes.length > 0) s.parentSpanId = f.bytes.toString("hex");
    else if (f.no === 5) s.name = f.bytes.toString("utf-8");
    else if (f.no === 7) s.start = f.bytes.readBigUInt64LE(0);
    else if (f.no === 8) s.end = f.bytes.readBigUInt64LE(0);
    else if (f.no === 9) keyValue(f.bytes, s.attributes);
    else if (f.no === 15) {
      for (const g of fields(f.bytes)) if (g.no === 3 && g.int === 2n) s.error = true;
    }
  }
  if (!s.spanId || s.name === undefined || s.start === undefined || s.end === undefined) return undefined;
  return s as CollectedSpan;
}

/** The spans of an `ExportTraceServiceRequest` in protobuf. */
export function decodeTracesProto(buf: Buffer): CollectedSpan[] {
  const out: CollectedSpan[] = [];
  for (const rs of fields(buf)) {
    if (rs.no !== 1 || !rs.bytes) continue;
    for (const ss of fields(rs.bytes)) {
      if (ss.no !== 2 || !ss.bytes) continue;
      for (const sp of fields(ss.bytes)) {
        if (sp.no !== 2 || !sp.bytes) continue;
        const span = protoSpan(sp.bytes);
        if (span) out.push(span);
      }
    }
  }
  return out;
}

// OTLP JSON

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function jsonValue(v: unknown): SpanValue | undefined {
  if (!isObj(v)) return undefined;
  if (typeof v.stringValue === "string") return v.stringValue;
  if (typeof v.boolValue === "boolean") return v.boolValue;
  if (typeof v.intValue === "string" || typeof v.intValue === "number") return Number(v.intValue);
  if (typeof v.doubleValue === "number") return v.doubleValue;
  return undefined;
}

const nanos = (v: unknown): bigint | undefined => {
  try {
    return typeof v === "string" || typeof v === "number" ? BigInt(v) : undefined;
  } catch {
    return undefined;
  }
};

/** The spans of an `ExportTraceServiceRequest` in OTLP/JSON. */
export function decodeTracesJson(body: unknown): CollectedSpan[] {
  const out: CollectedSpan[] = [];
  for (const rs of list(isObj(body) ? body.resourceSpans : undefined)) {
    if (!isObj(rs)) continue;
    for (const ss of list(rs.scopeSpans)) {
      if (!isObj(ss)) continue;
      for (const s of list(ss.spans)) {
        if (!isObj(s) || typeof s.spanId !== "string" || typeof s.name !== "string") continue;
        const start = nanos(s.startTimeUnixNano);
        const end = nanos(s.endTimeUnixNano);
        if (start === undefined || end === undefined) continue;
        const attributes: Record<string, SpanValue> = {};
        for (const kv of list(s.attributes)) {
          if (!isObj(kv) || typeof kv.key !== "string") continue;
          const v = jsonValue(kv.value);
          if (v !== undefined) attributes[kv.key] = v;
        }
        out.push({
          spanId: s.spanId,
          ...(typeof s.parentSpanId === "string" && s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
          name: s.name,
          start,
          end,
          attributes,
          ...(isObj(s.status) && (s.status.code === 2 || s.status.code === "STATUS_CODE_ERROR") ? { error: true } : {}),
        });
      }
    }
  }
  return out;
}

// The receiver

/** The header whose token says which run of the binary a batch of spans came from. */
export const ENGINE_RUN_HEADER = "x-chant-run";

/** Where a batch is forwarded: the product's own collector. */
export interface SpanForward {
  url: string;
  headers?: Record<string, string>;
}

/**
 * A loopback OTLP/HTTP trace endpoint for one run. It never holds the
 * process open, and a request it cannot read is answered and dropped. Spans
 * are kept by the key {@link SpanReceiver.exporter} was given.
 */
export class SpanReceiver {
  private server?: Server;
  private url = "";
  private readonly runs = new Map<string, string>();
  private readonly spans = new Map<string, CollectedSpan[]>();
  private readonly forwards: Promise<string | undefined>[] = [];
  /** Batches that could not be read, with why. */
  readonly unreadable: string[] = [];

  /** `forward`: a collector that also gets every batch the binary sends, unchanged. */
  constructor(private readonly forward?: SpanForward, private readonly fetchFn: typeof fetch = fetch) {}

  /** Start listening. Undefined when it is up; the problem when it could not start. */
  async listen(): Promise<string | undefined> {
    const server = createServer((req, res) => this.handle(req, res));
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
    } catch (e) {
      return (e as Error).message;
    }
    server.unref();
    const addr = server.address();
    if (!addr || typeof addr === "string") return "no port";
    this.server = server;
    this.url = `http://127.0.0.1:${addr.port}/v1/traces`;
    return undefined;
  }

  get listening(): boolean {
    return this.server !== undefined;
  }

  /** The variables one run of the binary gets so its spans come here, kept under `key`; none when the receiver is not listening. */
  exporter(key: string): Record<string, string> {
    if (!this.server) return {};
    const token = randomBytes(12).toString("hex");
    this.runs.set(token, key);
    return {
      OTEL_TRACES_EXPORTER: "otlp",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: this.url,
      OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: "http/protobuf",
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: `${ENGINE_RUN_HEADER}=${token}`,
    };
  }

  /** The spans the runs exported under `key` sent. */
  spansOf(key: string): CollectedSpan[] {
    return this.spans.get(key) ?? [];
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const type = String(req.headers["content-type"] ?? "");
      const proto = !type.includes("json");
      const reply = (status: number) => {
        res.writeHead(status, { "content-type": proto ? "application/x-protobuf" : "application/json" });
        res.end(proto ? "" : "{}");
      };
      const key = this.runs.get(String(req.headers[ENGINE_RUN_HEADER] ?? ""));
      if (req.method !== "POST" || key === undefined) return reply(req.method === "POST" ? 401 : 405);
      const raw = Buffer.concat(chunks);
      try {
        const encoding = String(req.headers["content-encoding"] ?? "").toLowerCase();
        const body = encoding === "gzip" ? gunzipSync(raw) : encoding === "deflate" ? inflateSync(raw) : raw;
        const got = proto ? decodeTracesProto(body) : decodeTracesJson(JSON.parse(body.toString("utf-8")));
        this.spans.set(key, [...(this.spans.get(key) ?? []), ...got]);
      } catch (e) {
        this.unreadable.push(`${key.replace(/\u0000/g, " ")}: ${(e as Error).message}`);
      }
      reply(200);
      if (this.forward) this.forwards.push(this.relay(raw, req));
    });
  }

  private async relay(raw: Buffer, req: IncomingMessage): Promise<string | undefined> {
    const t = this.forward!;
    const headers: Record<string, string> = { ...t.headers, "content-type": String(req.headers["content-type"] ?? "application/x-protobuf") };
    if (req.headers["content-encoding"]) headers["content-encoding"] = String(req.headers["content-encoding"]);
    try {
      const res = await this.fetchFn(t.url, { method: "POST", headers, body: new Uint8Array(raw), signal: AbortSignal.timeout(10_000) });
      return res.ok ? undefined : `${t.url} answered ${res.status}`;
    } catch (e) {
      return `${t.url}: ${(e as Error).message}`;
    }
  }

  /** Stop listening, once every forwarded batch is answered. Returns the forwards that failed. */
  async close(): Promise<string[]> {
    const problems = (await Promise.all(this.forwards)).filter((p): p is string => p !== undefined);
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    return problems;
  }
}

// Reading the spans

/** How many of each list a root's timings keep. */
export const TOP = 10;

const RESOURCE_SPANS = new Set(["Plan resource instance changes", "Apply resource instance changes"]);
const BUILTIN_PROVIDER = "terraform.io/builtin/terraform";
const PROVIDER_CALL = /^tfplugin[56]\.Provider\/(\w+)$/;

const ms = (s: CollectedSpan): number => Math.round(Number(s.end - s.start) / 1e5) / 10;
const str = (v: SpanValue | undefined): string | undefined => (v === undefined || v === "" ? undefined : String(v));
const num = (v: SpanValue | undefined): number | undefined => (typeof v === "number" ? v : typeof v === "string" && v !== "" && !Number.isNaN(Number(v)) ? Number(v) : undefined);
const slowest = <T extends { ms: number }>(xs: T[], n = TOP): T[] => [...xs].sort((a, b) => b.ms - a.ms).slice(0, n);
const defined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export interface RootFacts {
  /** The binary's name, for the notes. */
  binary: string;
  /** The root's wall time, init and show included. */
  seconds: number;
  /** The binary's plan run. Absent when the root never reached it. */
  planSeconds?: number;
  /** A tf-apply wave's apply run. Absent when the root was not applied. */
  applySeconds?: number;
  /** `terragrunt`: Terragrunt ran the binary, so the times are its run report's; the spans are its plan's, through a `TG_TF_PATH` wrapper the product sets. */
  source?: "binary" | "terragrunt";
}

/** A root's timings from the spans its plan sent. */
export function rootTimings(spans: CollectedSpan[], facts: RootFacts): EngineRootTimings {
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const refresh = new Map<string, number>();
  for (const s of spans) if (s.name === "Refresh resource instance" && s.parentSpanId) refresh.set(s.parentSpanId, (refresh.get(s.parentSpanId) ?? 0) + ms(s));

  const resources: EngineResourceTiming[] = spans.filter((s) => RESOURCE_SPANS.has(s.name)).map((s) => defined({
    address: str(s.attributes["opentofu.resource_instance.address"]) ?? "(no address)",
    type: str(s.attributes["opentofu.resource.type"]),
    action: str(s.attributes["opentofu.resource_instance.action"]),
    provider: str(s.attributes["opentofu.provider_instance.address"]),
    ms: ms(s),
    refresh_ms: refresh.get(s.spanId),
  }));

  const calls: EngineProviderCall[] = [];
  for (const s of spans) {
    const m = PROVIDER_CALL.exec(s.name);
    if (!m) continue;
    const parent = s.parentSpanId ? byId.get(s.parentSpanId) : undefined;
    calls.push(defined({
      method: str(s.attributes["rpc.method"]) ?? m[1],
      provider: str(s.attributes["opentofu.provider.address"]),
      type: str(s.attributes["opentofu.resource.type"]),
      address: parent && RESOURCE_SPANS.has(parent.name) ? str(parent.attributes["opentofu.resource_instance.address"]) : undefined,
      ms: ms(s),
    }));
  }

  // choudoufu starts each provider process inside a "Start provider" span.
  // OpenTofu has none: the nearest it sends is "Configure provider", which
  // names the provider in opentofu.provider.source. The builtin provider runs
  // in-process and is left out. A root with Start spans is read from those
  // alone, so choudoufu's Configure spans are not counted a second time.
  const startSpans = spans.filter((s) => s.name === "Start provider");
  const initSpans = startSpans.length > 0 ? startSpans : spans.filter((s) => s.name === "Configure provider" && str(s.attributes["opentofu.provider.source"]) !== BUILTIN_PROVIDER);
  const starts = new Map<string, { provider: string; count: number; ms: number; max_ms: number }>();
  for (const s of initSpans) {
    const provider = str(s.attributes["opentofu.provider.address"]) ?? str(s.attributes["opentofu.provider.source"]) ?? "(unnamed)";
    const e = starts.get(provider) ?? { provider, count: 0, ms: 0, max_ms: 0 };
    e.count++;
    e.ms = Math.round((e.ms + ms(s)) * 10) / 10;
    e.max_ms = Math.max(e.max_ms, ms(s));
    starts.set(provider, e);
  }

  const lockWaits = spans.filter((s) => s.name === "State lock wait").map((s) => defined({
    backend: str(s.attributes["opentofu.state.backend"]),
    operation: str(s.attributes["opentofu.state.lock.operation"]),
    attempts: num(s.attributes["opentofu.state.lock.attempts"]),
    ms: ms(s),
  }));

  const aggregates: EngineAggregate[] = spans.filter((s) => s.name.startsWith("Aggregate: ")).map((s) => {
    const a = s.attributes;
    return defined({
      of: s.name.slice("Aggregate: ".length),
      kind: str(a["choudoufu.aggregate.kind"]),
      type: str(a["opentofu.resource.type"]),
      provider: str(a["opentofu.provider.address"]),
      method: str(a["rpc.method"]),
      count: num(a["choudoufu.aggregate.count"]) ?? 0,
      detailed: num(a["choudoufu.aggregate.detailed_count"]) ?? 0,
      ms: num(a["choudoufu.aggregate.duration_total_ms"]) ?? 0,
      max_ms: num(a["choudoufu.aggregate.duration_max_ms"]) ?? 0,
      slowest: str(a["choudoufu.aggregate.slowest"]),
      groups: num(a["choudoufu.aggregate.groups"]),
    });
  });

  const summed = aggregates.filter((a) => a.kind !== "provider_call").reduce((n, a) => n + Math.max(0, a.count - a.detailed), 0);
  const detail: EngineRootTimings["detail"] = resources.length > 0 ? "resources" : aggregates.length > 0 ? "aggregate" : "none";
  const what = facts.applySeconds !== undefined ? "plan and apply" : "plan";
  let note: string | undefined;
  if (facts.source === "terragrunt" && spans.length === 0) note = `Terragrunt ran the binary for this unit, so its time is from Terragrunt's run report, and ${facts.binary} sent no spans for its plan, so it has no per-resource timings`;
  else if (facts.source === "terragrunt" && detail === "none") note = `Terragrunt ran the binary for this unit, so its time is from Terragrunt's run report; ${facts.binary} sent ${spans.length} span${spans.length === 1 ? "" : "s"} for its plan, none of them per resource`;
  else if (facts.planSeconds === undefined) note = "the root did not reach a plan, so no spans were read";
  else if (spans.length === 0) note = `${facts.binary} sent no spans for the ${what}, so this root has no per-resource timings. A binary that exports per-resource OpenTelemetry spans, such as choudoufu, gives them`;
  else if (detail === "none") note = `${facts.binary} sent ${spans.length} span${spans.length === 1 ? "" : "s"} for the ${what}, none of them per resource, so this root has no per-resource timings`;
  else if (detail === "aggregate") note = `${facts.binary} summed its resources by type instead of a span each, so the slowest are listed by type`;
  else if (summed > 0) note = `past the span budget, ${summed} resource instance${summed === 1 ? " is" : "s are"} summed by type instead of listed`;

  return {
    seconds: Math.round(facts.seconds * 100) / 100,
    ...(facts.planSeconds !== undefined ? { plan_seconds: Math.round(facts.planSeconds * 100) / 100 } : {}),
    ...(facts.applySeconds !== undefined ? { apply_seconds: Math.round(facts.applySeconds * 100) / 100 } : {}),
    ...(facts.source === "terragrunt" ? { source: "terragrunt" as const } : {}),
    spans: spans.length,
    detail,
    ...(note ? { note } : {}),
    resources: slowest(resources),
    provider_calls: slowest(calls),
    provider_init: slowest([...starts.values()]),
    lock_waits: slowest(lockWaits),
    aggregates: slowest(aggregates, 2 * TOP),
  };
}

/** The run's slowest roots and resources, from each root's timings. */
export function runTimings(roots: { path: string; timings?: EngineRootTimings }[], note?: string): EngineRunTimings {
  const timed = roots.filter((r): r is { path: string; timings: EngineRootTimings } => r.timings !== undefined);
  return {
    roots: [...timed]
      .sort((a, b) => b.timings.seconds - a.timings.seconds)
      .map((r) => ({
        root: r.path,
        seconds: r.timings.seconds,
        ...(r.timings.plan_seconds !== undefined ? { plan_seconds: r.timings.plan_seconds } : {}),
        ...(r.timings.apply_seconds !== undefined ? { apply_seconds: r.timings.apply_seconds } : {}),
        ...(r.timings.source ? { source: r.timings.source } : {}),
        detail: r.timings.detail,
      })),
    resources: slowest(timed.flatMap((r) => r.timings.resources.map((x) => ({ root: r.path, address: x.address, ...(x.type ? { type: x.type } : {}), ms: x.ms })))),
    ...(note ? { note } : {}),
  };
}

/** `850ms`, `3.2s`, `2m05s`. */
export function duration(msValue: number): string {
  if (msValue < 1000) return `${Math.round(msValue)}ms`;
  const s = msValue / 1000;
  if (s < 59.95) return `${s.toFixed(1)}s`;
  const total = Math.round(s);
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`;
}

// The hook

/** One engine command a root ran, as {@link EngineTimings} timed it. */
export interface EngineCommandTiming {
  /** The subcommand: `init`, `plan`, `show`, `apply`, `output`, `live-plan-set`... */
  command: string;
  /** The step method it ran in: `plan`, `run` or `outputs`. */
  method: string;
  seconds: number;
  code: number | null;
}

/** A root's timings with the commands they came from. */
export interface EngineRoot extends EngineRootTimings {
  root: string;
  /** Each engine command the root ran, in order; an upstream's reads for it are left out. */
  commands: EngineCommandTiming[];
  /** The engine's init runs alone. */
  init_seconds?: number;
  /** For a member of a composed group: every member, this one included. Its times and spans are the group's. */
  composed?: string[];
}

export interface EngineTimingsOptions {
  /** A collector each batch of the engine's spans is forwarded to, unchanged: the product's own, when it sends a trace. */
  forward?: SpanForward;
  fetch?: typeof fetch;
  /**
   * The product's own hook, run first for each command (its trace span, say).
   * Its variables are laid under the receiver's, and its `after` runs before
   * the timing is kept.
   */
  inner?: TerraformCommandHook;
  /** The commands whose spans count. Default `plan` and `apply`. */
  spanCommands?: readonly string[];
  /** The binary's name, for the notes. Default the name each command ran. */
  binary?: string;
  /** Leave the span receiver off: commands are still timed. */
  noSpans?: boolean;
}

/** The key spans are kept by: a root's, or a composed group's, and the command. */
const keyOf = (roots: readonly string[], command: string): string => `${roots.join("\u0001")}\u0000${command}`;

/**
 * The engine timings of one run (chant#4887): {@link EngineTimings.onCommand}
 * goes in `terraformApplyCapabilityWith({ onCommand })`, and once the wave
 * ran, {@link EngineTimings.roots} gives each root's timings and
 * {@link EngineTimings.run} the run's slowest roots and resources. Call
 * {@link EngineTimings.close} once, after the last command.
 */
export class EngineTimings {
  /** Why the engine's spans are not collected, when the receiver could not listen. Commands are timed all the same. */
  readonly problem?: string;
  private readonly commands = new Map<string, EngineCommandTiming[]>();
  private readonly groups = new Map<string, string[]>();
  private readonly binaries = new Map<string, string>();
  private readonly spanCommands: readonly string[];

  private constructor(private readonly options: EngineTimingsOptions, private readonly receiver: SpanReceiver | undefined, problem?: string) {
    this.spanCommands = options.spanCommands ?? ["plan", "apply"];
    if (problem) this.problem = problem;
  }

  /** Start the receiver (unless `noSpans`) and answer the timings. Never throws: a receiver that cannot listen leaves `problem` set. */
  static async start(options: EngineTimingsOptions = {}): Promise<EngineTimings> {
    if (options.noSpans) return new EngineTimings(options, undefined);
    const receiver = new SpanReceiver(options.forward, options.fetch);
    const problem = await receiver.listen();
    return problem ? new EngineTimings(options, undefined, problem) : new EngineTimings(options, receiver);
  }

  /** Batches of spans that could not be read, with why. */
  get unreadable(): readonly string[] {
    return this.receiver?.unreadable ?? [];
  }

  /** The hook to pass as `onCommand`. */
  readonly onCommand: TerraformCommandHook = async (c: TerraformCommand) => {
    const inner = (await this.options.inner?.(c)) ?? {};
    // An upstream's reads for a root are the upstream's, not the root's: only the product's own hook sees them.
    if (c.upstream !== undefined) return inner;
    const roots = c.members && c.members.length > 0 ? [...c.members] : [c.root];
    if (roots.length > 1) for (const r of roots) this.groups.set(r, roots);
    for (const r of roots) this.binaries.set(r, (c.binary.split("/").pop() || c.binary));
    const exporter = this.receiver && this.spanCommands.includes(c.name) ? this.receiver.exporter(keyOf(roots, c.name)) : {};
    return {
      env: { ...(inner.env ?? {}), ...exporter },
      after: async (r: TerraformCommandResult) => {
        try {
          await inner.after?.(r);
        } finally {
          for (const root of roots) {
            const list = this.commands.get(root) ?? [];
            list.push({ command: c.name, method: c.method, seconds: r.seconds, code: r.code });
            this.commands.set(root, list);
          }
        }
      },
    };
  };

  /** One root's timings, or undefined when it ran no command. */
  root(root: string): EngineRoot | undefined {
    const commands = this.commands.get(root);
    if (!commands) return undefined;
    const group = this.groups.get(root) ?? [root];
    const sum = (name: string): number | undefined => commands.filter((x) => x.command === name).reduce<number | undefined>((n, x) => (n ?? 0) + x.seconds, undefined);
    const plan = sum("plan") ?? sum("live-plan-set");
    const apply = sum("apply") ?? sum("live-wave-apply");
    const init = sum("init");
    const spans = this.spanCommands.flatMap((name) => this.receiver?.spansOf(keyOf(group, name)) ?? []);
    const timings = rootTimings(spans, {
      binary: this.options.binary ?? this.binaries.get(root) ?? "the binary",
      seconds: commands.reduce((n, x) => n + x.seconds, 0),
      ...(plan !== undefined ? { planSeconds: plan } : {}),
      ...(apply !== undefined ? { applySeconds: apply } : {}),
    });
    return {
      root,
      ...timings,
      commands: commands.map((x) => ({ ...x })),
      ...(init !== undefined ? { init_seconds: Math.round(init * 100) / 100 } : {}),
      ...(group.length > 1 ? { composed: [...group] } : {}),
    };
  }

  /** Every root that ran a command, by root. */
  roots(): Record<string, EngineRoot> {
    const out: Record<string, EngineRoot> = {};
    for (const root of [...this.commands.keys()].sort()) out[root] = this.root(root)!;
    return out;
  }

  /** The run's slowest roots and resources; a composed group's resources count once. */
  run(note?: string): EngineRunTimings {
    const roots = Object.values(this.roots());
    const once = new Set<string>();
    const forResources = roots.filter((r) => {
      const k = (r.composed ?? [r.root]).join("\u0001");
      if (once.has(k)) return false;
      once.add(k);
      return true;
    });
    const all = runTimings(roots.map((r) => ({ path: r.root, timings: r })), note);
    const resources = runTimings(forResources.map((r) => ({ path: r.composed ? r.composed.join(", ") : r.root, timings: r }))).resources;
    return { ...all, resources };
  }

  /** Stop the receiver, once every forwarded batch is answered. Returns the forwards that failed. */
  async close(): Promise<string[]> {
    return this.receiver ? this.receiver.close() : [];
  }
}

/** {@link EngineTimings.start}: the engine timings of one run, whose `onCommand` goes in `terraformApplyCapabilityWith`. */
export function engineTimings(options: EngineTimingsOptions = {}): Promise<EngineTimings> {
  return EngineTimings.start(options);
}
