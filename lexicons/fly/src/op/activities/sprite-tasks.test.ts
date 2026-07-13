import { describe, test, expect, beforeAll, afterAll } from "vitest";
import {
  loadActivities,
  runOpLocally,
  phase,
  spriteCreate,
  spriteApplyNetworkPolicy,
  spriteTaskCreate,
  spriteWriteFile,
  spriteApplyServices,
  spriteExec,
  spriteTaskRelease,
  spriteDestroy,
  type ActivityFn,
  type ActivityProfile,
  type OpConfig,
} from "@intentius/chant/op";
import { createSpritesFake } from "./sprites-fake";
import { spriteCreate as createImpl } from "./sprites";
import {
  spriteTaskCreate as taskCreateImpl,
  spriteTaskRefresh as taskRefreshImpl,
  spriteTaskRelease as taskReleaseImpl,
  spriteTasksUrl,
} from "./sprite-tasks";

// Keep-alive Tasks (#847) + the full Managed Agents session Op, end-to-end
// against the in-process fake (S7). No Docker, no key — runs in CI.

const PROFILES: Record<string, ActivityProfile> = {
  longInfra: { startToCloseTimeout: "5m", retry: { maximumAttempts: 3, initialInterval: "1ms", backoffCoefficient: 1 } },
  fastIdempotent: { startToCloseTimeout: "5m", retry: { maximumAttempts: 2, initialInterval: "1ms", backoffCoefficient: 1 } },
};

let fake: { url: string; close(): Promise<void> };
let activities: Map<string, ActivityFn>;
let prevBaseUrl: string | undefined;

beforeAll(async () => {
  fake = await createSpritesFake();
  prevBaseUrl = process.env.SPRITES_BASE_URL;
  process.env.SPRITES_BASE_URL = fake.url;
  activities = await loadActivities(["fly"]);
});

afterAll(async () => {
  if (prevBaseUrl === undefined) delete process.env.SPRITES_BASE_URL;
  else process.env.SPRITES_BASE_URL = prevBaseUrl;
  await fake?.close();
});

async function inspect(id: string): Promise<{
  status: string;
  fs: Record<string, string>;
  netPolicy: Array<{ domain: string; action: string }>;
  services: Record<string, { state: { status: string } }>;
  tasks: Record<string, unknown>;
}> {
  const res = await fetch(`${fake.url}/v1/sprites/${id}`);
  return (await res.json()) as never;
}

describe("spriteTaskUrl (pure)", () => {
  test("builds the sprite-scoped tasks path", () => {
    expect(spriteTasksUrl("http://h", "s 1")).toBe("http://h/v1/sprites/s%201/tasks");
  });
});

describe("keep-alive task activities", () => {
  test("create → refresh → release, release is idempotent", async () => {
    await createImpl({ name: "ka-1", endpoint: fake.url });
    await taskCreateImpl({ id: "ka-1", name: "session", expire: "5m", endpoint: fake.url });
    expect(Object.keys((await inspect("ka-1")).tasks)).toEqual(["session"]);

    await taskRefreshImpl({ id: "ka-1", name: "session", expire: "5m", endpoint: fake.url });
    await taskReleaseImpl({ id: "ka-1", name: "session", endpoint: fake.url });
    expect(Object.keys((await inspect("ka-1")).tasks)).toEqual([]);

    // Idempotent: releasing an already-gone task is a no-op (404 tolerated).
    await expect(taskReleaseImpl({ id: "ka-1", name: "session", endpoint: fake.url })).resolves.toBeDefined();
  });

  test("refreshing a missing task throws", async () => {
    await createImpl({ name: "ka-2", endpoint: fake.url });
    await expect(taskRefreshImpl({ id: "ka-2", name: "nope", endpoint: fake.url })).rejects.toThrow(/refresh failed/);
  });

  test("task activities resolve by name", () => {
    for (const fn of ["spriteTaskCreate", "spriteTaskRefresh", "spriteTaskRelease"]) {
      expect(typeof activities.get(fn)).toBe("function");
    }
  });
});

describe("Managed Agents session Op (#847)", () => {
  const SESSION = "agent-session-t1";
  test("Create → Secure → Hold → Stage → Runner → Run → Release → Destroy runs green", async () => {
    const op: OpConfig = {
      name: "managed-agent-session",
      overview: "one session end-to-end",
      taskQueue: "sprites",
      phases: [
        phase("Create", [spriteCreate({ name: SESSION })]),
        phase("Secure", [
          spriteApplyNetworkPolicy({
            id: SESSION,
            rules: [
              { domain: "api.anthropic.com", action: "allow" },
              { domain: "*", action: "deny" },
            ],
          }),
        ]),
        phase("Hold", [spriteTaskCreate({ id: SESSION, name: "session", expire: "5m" })]),
        phase("Stage", [spriteWriteFile({ id: SESSION, path: "/run/agent.env", mkdir: true, content: "ANTHROPIC_SESSION_ID=agent-session-t1" })]),
        phase("Runner", [
          spriteApplyServices({
            id: SESSION,
            start: true,
            services: [{ name: "agent-runner", cmd: "agent-runner", dir: "/run", http_port: 8080 }],
          }),
        ]),
        phase("Run", [spriteExec({ id: SESSION, cmd: "echo session-complete > /run/status" })]),
        phase("Release", [spriteTaskRelease({ id: SESSION, name: "session" })]),
        phase("Destroy", [spriteDestroy({ id: SESSION })]),
      ],
    };
    const result = await runOpLocally(op, activities, PROFILES);
    expect(result.ok).toBe(true);
    expect(result.records.map((r) => r.fn)).toEqual([
      "spriteCreate",
      "spriteApplyNetworkPolicy",
      "spriteTaskCreate",
      "spriteWriteFile",
      "spriteApplyServices",
      "spriteExec",
      "spriteTaskRelease",
      "spriteDestroy",
    ]);
    expect(result.records.every((r) => r.status === "ok")).toBe(true);
  });

  test("mid-session state: policy set, runner running, task held, before teardown", async () => {
    const id = "agent-session-t2";
    const op: OpConfig = {
      name: "managed-agent-session-partial",
      overview: "up to Run, no teardown, so state is observable",
      phases: [
        phase("Create", [spriteCreate({ name: id })]),
        phase("Secure", [
          spriteApplyNetworkPolicy({ id, rules: [{ domain: "api.anthropic.com", action: "allow" }, { domain: "*", action: "deny" }] }),
        ]),
        phase("Hold", [spriteTaskCreate({ id, name: "session", expire: "5m" })]),
        phase("Runner", [spriteApplyServices({ id, start: true, services: [{ name: "agent-runner", cmd: "agent-runner" }] })]),
      ],
    };
    await runOpLocally(op, activities, PROFILES);
    const s = await inspect(id);
    expect(s.netPolicy).toEqual([
      { domain: "api.anthropic.com", action: "allow" },
      { domain: "*", action: "deny" },
    ]);
    expect(s.services["agent-runner"].state.status).toBe("running");
    expect(Object.keys(s.tasks)).toEqual(["session"]);
  });
});
