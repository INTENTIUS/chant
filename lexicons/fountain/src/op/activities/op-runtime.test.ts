/**
 * fountainApply and fountainRun as Op activities (#2775): loaded through
 * `loadActivities(["fountain"])` and run by the local executor, which calls
 * every activity as `fn(args, signal)`, against an in-process fake of
 * fountain's REST API. The unit tests beside this file call the functions
 * directly with a fake client and so never saw the executor's signal land in
 * the client's parameter.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  activity,
  loadActivities,
  phase,
  runOpLocally,
  OpRunFailure,
  type ActivityFn,
  type ActivityProfile,
  type OpConfig,
} from "@intentius/chant/op";

const MANIFEST = `apiVersion: fountain.dev/v1
kind: Environment
metadata:
  name: box-env
spec:
  networking_type: limited
---
apiVersion: fountain.dev/v1
kind: Agent
metadata:
  name: box
spec:
  model: a/m
  runtime: claude
  environment: box-env
  sandbox_mode: persistent
`;

const PROFILES: Record<string, ActivityProfile> = {
  fastIdempotent: { timeout: "10s", retry: { maximumAttempts: 1 } },
  // The profile the abort cases run under, cut to 150ms so the executor aborts the step.
  atMostOnce: { timeout: "150ms", retry: { maximumAttempts: 1 } },
};

interface FakeFountain {
  url: string;
  calls: string[];
  /** The conversation statuses GET hands out, the last repeating. */
  statuses: string[];
  close(): Promise<void>;
}

async function startFakeFountain(): Promise<FakeFountain> {
  const fake = { calls: [] as string[], statuses: ["pending", "running", "idle"] } as FakeFountain;
  let polls = 0;
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const key = `${req.method} ${req.url}`;
      fake.calls.push(key);
      const reply = (status: number, json: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      };
      if (req.headers.authorization !== "Bearer tok") return reply(401, { error: "unauthorized" });
      if (key === "POST /api/apply") {
        const { resources } = JSON.parse(raw) as { resources: Array<{ kind: string; name: string }> };
        return reply(200, {
          data: {
            results: resources.map((r) => ({ kind: r.kind, name: r.name, action: "created", errors: null, secrets: [] })),
          },
        });
      }
      if (key === "GET /api/agents?search=box") {
        return reply(200, { data: [{ id: "agent-1", name: "box", sandbox_mode: "persistent" }] });
      }
      if (key === "POST /api/conversations") return reply(201, { data: { id: "conv-1" } });
      if (key === "GET /api/conversations/conv-1") {
        const status = fake.statuses[Math.min(polls, fake.statuses.length - 1)];
        polls += 1;
        return reply(200, { data: { status } });
      }
      if (key === "GET /api/conversations/conv-1/turns") {
        return reply(200, { data: [{ turn_number: 1, status: "completed" }] });
      }
      if (key === "POST /api/conversations/conv-1/terminate") return reply(200, { data: {} });
      reply(404, { error: `unrouted: ${key}` });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise<void>((r) => server.close(() => r()));
  Object.defineProperty(fake, "reset", {
    value: (statuses: string[]) => {
      fake.calls.length = 0;
      fake.statuses = statuses;
      polls = 0;
    },
  });
  return fake;
}

let fake: FakeFountain & { reset(statuses: string[]): void };
let activities: Map<string, ActivityFn>;

beforeAll(async () => {
  fake = (await startFakeFountain()) as typeof fake;
  activities = await loadActivities(["fountain"]);
});

afterAll(async () => {
  await fake?.close();
});

beforeEach(() => fake.reset(["pending", "running", "idle"]));

const connection = () => ({ endpoint: fake.url, token: "tok" });

describe("fountain activities under the local Op runtime (#2775)", () => {
  it("are registered by loadActivities(['fountain'])", () => {
    expect(activities.get("fountainApply")).toBeTypeOf("function");
    expect(activities.get("fountainRun")).toBeTypeOf("function");
  });

  it("apply the manifest and start the conversation, called as fn(args, signal)", async () => {
    const op: OpConfig = {
      name: "fountain-box",
      overview: "apply a Box and start its agent",
      phases: [
        phase("Apply", [activity("fountainApply", { manifestContent: MANIFEST, ...connection() })]),
        phase("Start", [
          activity("fountainRun", { agent: "box", prompt: "hi", pollMs: 1, ...connection() }, { id: "run" }),
        ]),
      ],
    };
    const result = await runOpLocally(op, activities, PROFILES);
    expect(result.status).toBe("ok");
    expect(result.records.map((r) => [r.fn, r.status])).toEqual([
      ["fountainApply", "ok"],
      ["fountainRun", "ok"],
    ]);
    expect(fake.calls).toContain("POST /api/apply");
    expect(fake.calls).toContain("POST /api/conversations");
    // Persistent and finished: nothing terminated.
    expect(fake.calls).not.toContain("POST /api/conversations/conv-1/terminate");
  });

  it("fountainRun stops polling when the step is aborted, and the terminate policy decides", async () => {
    fake.reset(["running"]);
    const op: OpConfig = {
      name: "fountain-hung",
      overview: "a turn that never ends",
      phases: [
        phase("Start", [
          activity(
            "fountainRun",
            { agent: "box", prompt: "hi", pollMs: 10, terminate: "on-deadline", ...connection() },
            "atMostOnce",
          ),
        ]),
      ],
    };
    const err = await runOpLocally(op, activities, PROFILES).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(OpRunFailure);
    expect((err as OpRunFailure).result.records[0].error).toMatch(/timed out/);
    // Let the aborted activity's terminate call land, then check polling stopped.
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.calls).toContain("POST /api/conversations/conv-1/terminate");
    const polls = fake.calls.filter((c) => c === "GET /api/conversations/conv-1").length;
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.calls.filter((c) => c === "GET /api/conversations/conv-1").length).toBe(polls);
  });

  it("fountainRun leaves a persistent agent's machine alone on abort (terminate: never, its default)", async () => {
    fake.reset(["running"]);
    const op: OpConfig = {
      name: "fountain-hung-persistent",
      overview: "a turn that never ends, on a home",
      phases: [phase("Start", [activity("fountainRun", { agent: "box", prompt: "hi", pollMs: 10, ...connection() }, "atMostOnce")])],
    };
    await expect(runOpLocally(op, activities, PROFILES)).rejects.toBeInstanceOf(OpRunFailure);
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.calls).not.toContain("POST /api/conversations/conv-1/terminate");
  });
});
