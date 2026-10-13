/**
 * A stand-in for an agent: it makes no model call, and every run emits the
 * spans a real one would, following the OpenTelemetry GenAI semantic
 * conventions. One run is an `invoke_agent` span with `chat` and
 * `execute_tool` children, carrying `gen_ai.*` attributes and token usage,
 * and one log record. They go to the collector agent on the node as OTLP/HTTP
 * JSON, written by hand so the image needs nothing beyond Node.
 *
 * Runs are numbered, and the number decides what happens, so every run of
 * the example sends the same mix: every ERROR_EVERY-th run the tool times
 * out and the run fails, every SLOW_EVERY-th run takes three seconds. Each
 * `chat` span also carries `gen_ai.input.messages`, the prompt, and the last
 * one `gen_ai.output.messages`, the answer: content the gateway's GenAI
 * preset deletes before anything is stored.
 *
 *   OTLP_ENDPOINT   base URL of the collector's OTLP/HTTP receiver
 *   INTERVAL_MS     time between runs (default 2000)
 *   ERROR_EVERY     default 5: one run in five fails
 *   SLOW_EVERY      default 7: one run in seven is slow
 *   RUNS            stop after this many runs (default: run forever)
 */
import { randomBytes } from "node:crypto";

const endpoint = process.env.OTLP_ENDPOINT ?? "http://localhost:4318";
const intervalMs = Number(process.env.INTERVAL_MS ?? 2000);
const errorEvery = Number(process.env.ERROR_EVERY ?? 5);
const slowEvery = Number(process.env.SLOW_EVERY ?? 7);
const maxRuns = process.env.RUNS ? Number(process.env.RUNS) : Infinity;

const SERVICE = "support-agent";
const AGENT = "support";
const PROVIDER = "demo";
const MODEL = "demo-small";
const TOOL = "lookup_order";

// OTLP enums: span kinds and status codes.
const INTERNAL = 1;
const CLIENT = 3;
const STATUS_OK = 1;
const STATUS_ERROR = 2;

type Value = string | number | string[];
interface AnyValue {
  stringValue?: string;
  intValue?: string;
  arrayValue?: { values: AnyValue[] };
}
interface KeyValue {
  key: string;
  value: AnyValue;
}

function anyValue(v: string | number): AnyValue {
  return typeof v === "number" ? { intValue: String(v) } : { stringValue: v };
}

function attrs(record: Record<string, Value>): KeyValue[] {
  return Object.entries(record).map(([key, v]) => ({
    key,
    value: Array.isArray(v) ? { arrayValue: { values: v.map(anyValue) } } : anyValue(v),
  }));
}

function id(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

const ms = (t: number): string => (BigInt(t) * 1_000_000n).toString();

interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: KeyValue[];
  status: { code: number; message?: string };
}

const resource = {
  attributes: attrs({
    "service.name": SERVICE,
    "service.version": "0.1.0",
    "deployment.environment.name": "k3d",
  }),
};
const scope = { name: "agent-observability-demo", version: "0.1.0" };

async function post(path: string, body: unknown): Promise<void> {
  const res = await fetch(`${endpoint}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`);
}

/** One agent run: its spans, and whether it failed. */
function run(n: number, end: number): { spans: Span[]; failed: boolean; traceId: string; rootId: string } {
  const failed = n % errorEvery === 0;
  const slow = n % slowEvery === 0;
  const duration = slow ? 3000 : 900;
  const start = end - duration;
  const traceId = id(16);
  const rootId = id(8);
  const conversation = `conv-${n}`;

  const spans: Span[] = [];
  const child = (name: string, kind: number, from: number, to: number, a: Record<string, Value>, error?: string): void => {
    spans.push({
      traceId,
      spanId: id(8),
      parentSpanId: rootId,
      name,
      kind,
      startTimeUnixNano: ms(from),
      endTimeUnixNano: ms(to),
      attributes: attrs(error ? { ...a, "error.type": error } : a),
      status: error ? { code: STATUS_ERROR, message: error } : { code: STATUS_OK },
    });
  };

  const question = `Where is order ${1000 + n}?`;
  const chat = (input: number, output: number, finish: string, answer?: string): Record<string, Value> => ({
    "gen_ai.operation.name": "chat",
    "gen_ai.provider.name": PROVIDER,
    "gen_ai.request.model": MODEL,
    "gen_ai.response.model": MODEL,
    "gen_ai.conversation.id": conversation,
    "gen_ai.usage.input_tokens": input,
    "gen_ai.usage.output_tokens": output,
    "gen_ai.response.finish_reasons": [finish],
    "gen_ai.input.messages": JSON.stringify([{ role: "user", parts: [{ type: "text", content: question }] }]),
    ...(answer ? { "gen_ai.output.messages": JSON.stringify([{ role: "assistant", parts: [{ type: "text", content: answer }] }]) } : {}),
  });

  const firstInput = 120 + (n % 5) * 10;
  child(`chat ${MODEL}`, CLIENT, start + 10, start + 400, chat(firstInput, 24, "tool_calls"));

  const toolEnd = failed ? start + 400 + (duration - 420) : start + 600;
  child(
    `execute_tool ${TOOL}`,
    INTERNAL,
    start + 410,
    toolEnd,
    {
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": TOOL,
      "gen_ai.tool.type": "function",
      "gen_ai.tool.call.id": `call-${n}`,
    },
    failed ? "timeout" : undefined,
  );

  if (!failed) {
    child(`chat ${MODEL}`, CLIENT, start + 610, end - 10, chat(firstInput + 60, 60, "stop", `Order ${1000 + n} is on its way.`));
  }

  spans.unshift({
    traceId,
    spanId: rootId,
    name: `invoke_agent ${AGENT}`,
    kind: INTERNAL,
    startTimeUnixNano: ms(start),
    endTimeUnixNano: ms(end),
    attributes: attrs({
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.provider.name": PROVIDER,
      "gen_ai.agent.name": AGENT,
      "gen_ai.agent.id": `${AGENT}-v1`,
      "gen_ai.request.model": MODEL,
      "gen_ai.conversation.id": conversation,
      ...(failed ? { "error.type": "timeout" } : {}),
    }),
    status: failed ? { code: STATUS_ERROR, message: `${TOOL} timed out` } : { code: STATUS_OK },
  });

  return { spans, failed, traceId, rootId };
}

async function send(n: number): Promise<void> {
  const now = Date.now();
  const { spans, failed, traceId, rootId } = run(n, now);
  await post("/v1/traces", { resourceSpans: [{ resource, scopeSpans: [{ scope, spans }] }] });
  const logRecords = [
    {
      timeUnixNano: ms(now),
      severityNumber: failed ? 17 : 9,
      severityText: failed ? "ERROR" : "INFO",
      body: { stringValue: failed ? `run ${n} failed: ${TOOL} timed out` : `run ${n} answered` },
      traceId,
      spanId: rootId,
      attributes: attrs({ "gen_ai.agent.name": AGENT, run: n }),
    },
  ];
  await post("/v1/logs", { resourceLogs: [{ resource, scopeLogs: [{ scope, logRecords }] }] });
  console.log(`run ${n}: trace ${traceId}${failed ? " (failed)" : ""}`);
}

for (let n = 1; n <= maxRuns; n++) {
  try {
    await send(n);
  } catch (err) {
    console.error(`run ${n}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (n < maxRuns) await new Promise((r) => setTimeout(r, intervalMs));
}
