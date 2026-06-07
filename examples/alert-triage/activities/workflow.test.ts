// Time-skipping test for the triage workflow (modeled on the temporal lexicon's
// #161 runtime harness). Runs the real workflow on a Temporal test server with
// mocked activities, and proves: safe remediations skip the gate, risky ones
// wait for the approval signal (and proceed on it), and an unsignalled risky one
// waits out the gate and is held (not approved).
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { fileURLToPath } from "node:url";
import type { Alert, Classification, TriageContext, Remediation } from "./triage";

const WF_PATH = fileURLToPath(new URL("./workflow.ts", import.meta.url));

let env: TestWorkflowEnvironment;
let counter = 0;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
}, 120_000);

afterAll(async () => {
  await env?.teardown();
});

function mockActivities(risky: boolean, record: { approved?: boolean; calls: string[] }) {
  return {
    classifyAlert: async (): Promise<Classification> => {
      record.calls.push("classify");
      return { severity: risky ? "critical" : "low", rationale: "mock" };
    },
    gatherContext: async (): Promise<TriageContext> => {
      record.calls.push("context");
      return { signals: ["mock"] };
    },
    proposeRemediation: async (): Promise<Remediation> => {
      record.calls.push("propose");
      return { summary: "mock fix", risky };
    },
    notifyOutcome: async (input: { approved: boolean }): Promise<void> => {
      record.calls.push("notify");
      record.approved = input.approved;
    },
  };
}

async function runTriage(opts: { risky: boolean; signal?: boolean }) {
  const record: { approved?: boolean; calls: string[] } = { calls: [] };
  const taskQueue = `alert-triage-test-${counter++}`;
  const worker = await Worker.create({
    connection: env.nativeConnection,
    namespace: env.namespace,
    taskQueue,
    workflowsPath: WF_PATH,
    activities: mockActivities(opts.risky, record),
  });
  const alert: Alert = { id: "a1", title: "test alert" };
  const handle = await env.client.workflow.start("alertTriage", {
    taskQueue,
    workflowId: `${taskQueue}-wf`,
    args: [alert],
  });
  if (opts.signal) await handle.signal("approve-remediation");
  await worker.runUntil(handle.result());

  const desc = await handle.describe();
  const durationMs =
    desc.closeTime && desc.startTime ? desc.closeTime.getTime() - desc.startTime.getTime() : 0;
  return { record, durationMs };
}

describe("alert-triage workflow", () => {
  test("safe remediation auto-approves and skips the gate", async () => {
    const { record, durationMs } = await runTriage({ risky: false });
    expect(record.calls).toEqual(["classify", "context", "propose", "notify"]);
    expect(record.approved).toBe(true);
    expect(durationMs).toBeLessThan(60 * 60 * 1000); // no 12h wait
  }, 120_000);

  test("risky remediation proceeds once the approval signal arrives", async () => {
    const { record, durationMs } = await runTriage({ risky: true, signal: true });
    expect(record.approved).toBe(true);
    expect(record.calls).toContain("notify");
    expect(durationMs).toBeLessThan(60 * 60 * 1000); // signal short-circuits the gate
  }, 120_000);

  test("risky remediation without approval waits out the gate and is held", async () => {
    const { record, durationMs } = await runTriage({ risky: true });
    expect(record.approved).toBe(false);
    expect(durationMs).toBeGreaterThan(11 * 60 * 60 * 1000); // ~12h gate timeout
  }, 120_000);
});
