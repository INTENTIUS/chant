/**
 * The demo agent (app/agent.ts) emits what the GenAI semantic conventions
 * describe, checked without a cluster: it runs under Node's type stripping
 * against a local HTTP server standing in for the collector's OTLP/HTTP
 * receiver, and the test reads back the JSON it posted.
 */
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { GENAI_ATTRIBUTES } from "@intentius/chant-lexicon-otel";
import { exampleDir } from "./built";

interface KeyValue {
  key: string;
  value: { stringValue?: string; intValue?: string; arrayValue?: { values: unknown[] } };
}
interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: KeyValue[];
  status: { code: number };
}

const RUNS = 10;
const posts: Array<{ path: string; body: any }> = [];
let server: Server;

function attr(span: Span, key: string): string | undefined {
  const v = span.attributes.find((a) => a.key === key)?.value;
  return v?.stringValue ?? v?.intValue;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      posts.push({ path: req.url ?? "", body: JSON.parse(body) });
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;

  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", join(exampleDir, "app", "agent.ts")], {
    env: { ...process.env, OTLP_ENDPOINT: `http://127.0.0.1:${port}`, INTERVAL_MS: "0", RUNS: String(RUNS) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));
  const code = await new Promise<number | null>((r) => child.on("exit", r));
  if (code !== 0) throw new Error(`app/agent.ts exited ${code}: ${stderr}`);
}, 30_000);

afterAll(() => {
  server?.close();
});

function traces(): Span[][] {
  return posts
    .filter((p) => p.path === "/v1/traces")
    .map((p) => p.body.resourceSpans[0].scopeSpans[0].spans as Span[]);
}

describe("the demo agent", () => {
  test("posts one trace and one log record per run, as support-agent", () => {
    expect(traces()).toHaveLength(RUNS);
    expect(posts.filter((p) => p.path === "/v1/logs")).toHaveLength(RUNS);
    const resource = posts[0].body.resourceSpans[0].resource.attributes as KeyValue[];
    expect(resource.find((a) => a.key === "service.name")?.value.stringValue).toBe("support-agent");
  });

  test("each run is an invoke_agent span with chat and execute_tool children in one trace", () => {
    for (const spans of traces()) {
      const [root, ...children] = spans;
      expect(root.name).toBe("invoke_agent support");
      expect(attr(root, GENAI_ATTRIBUTES.operationName)).toBe("invoke_agent");
      expect(attr(root, GENAI_ATTRIBUTES.agentName)).toBe("support");
      expect(root.parentSpanId).toBeUndefined();
      for (const child of children) {
        expect(child.traceId).toBe(root.traceId);
        expect(child.parentSpanId).toBe(root.spanId);
        expect(BigInt(child.startTimeUnixNano) >= BigInt(root.startTimeUnixNano)).toBe(true);
        expect(BigInt(child.endTimeUnixNano) <= BigInt(root.endTimeUnixNano)).toBe(true);
      }
      const ops = children.map((c) => attr(c, GENAI_ATTRIBUTES.operationName));
      expect(ops[0]).toBe("chat");
      expect(ops[1]).toBe("execute_tool");
    }
  });

  test("chat spans are CLIENT spans with a model, token usage and the prompt the collector removes", () => {
    const chats = traces().flatMap((spans) => spans.filter((s) => attr(s, GENAI_ATTRIBUTES.operationName) === "chat"));
    expect(chats.length).toBeGreaterThan(RUNS);
    for (const chat of chats) {
      expect(chat.kind).toBe(3);
      expect(chat.name).toBe(`chat ${attr(chat, GENAI_ATTRIBUTES.requestModel)}`);
      expect(Number(attr(chat, GENAI_ATTRIBUTES.inputTokens))).toBeGreaterThan(0);
      expect(Number(attr(chat, GENAI_ATTRIBUTES.outputTokens))).toBeGreaterThan(0);
      expect(attr(chat, GENAI_ATTRIBUTES.providerName)).toBe("demo");
      expect(attr(chat, "gen_ai.input.messages")).toMatch(/order \d+/);
    }
  });

  test("every fifth run fails in its tool, with error.type on the tool span and the run", () => {
    const failed = traces().filter((spans) => spans[0].status.code === 2);
    expect(failed).toHaveLength(RUNS / 5);
    for (const spans of failed) {
      const tool = spans.find((s) => attr(s, GENAI_ATTRIBUTES.operationName) === "execute_tool")!;
      expect(tool.status.code).toBe(2);
      expect(attr(tool, GENAI_ATTRIBUTES.errorType)).toBe("timeout");
      expect(attr(tool, GENAI_ATTRIBUTES.toolName)).toBe("lookup_order");
      expect(attr(spans[0], GENAI_ATTRIBUTES.errorType)).toBe("timeout");
    }
  });

  test("every seventh run takes three seconds, over the gateway's two-second sampling threshold", () => {
    const slow = traces().filter((spans) => BigInt(spans[0].endTimeUnixNano) - BigInt(spans[0].startTimeUnixNano) >= 2_000_000_000n);
    expect(slow).toHaveLength(Math.floor(RUNS / 7));
  });
});
