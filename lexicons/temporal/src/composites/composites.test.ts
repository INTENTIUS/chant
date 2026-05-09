/**
 * Composite unit tests — TemporalDevStack, TemporalCloudStack, WatchOp.
 */

import { describe, test, expect } from "vitest";
import { TemporalDevStack } from "./dev-stack";
import { TemporalCloudStack } from "./cloud-stack";
import { WatchOp } from "./watch-op";
import { serializeOps } from "../op/serializer";
import { DECLARABLE_MARKER } from "@intentius/chant/declarable";

function getProps(entity: unknown): Record<string, unknown> {
  return (entity as { props: Record<string, unknown> }).props;
}

function getEntityType(entity: unknown): string {
  return (entity as Record<string, unknown>).entityType as string;
}

// ── TemporalDevStack ─────────────────────────────────────────────────

describe("TemporalDevStack: basic", () => {
  test("returns server and ns", () => {
    const result = TemporalDevStack();
    expect(result.server).toBeDefined();
    expect(result.ns).toBeDefined();
  });

  test("server has entityType Temporal::Server", () => {
    const { server } = TemporalDevStack();
    expect(getEntityType(server)).toBe("Temporal::Server");
  });

  test("ns has entityType Temporal::Namespace", () => {
    const { ns } = TemporalDevStack();
    expect(getEntityType(ns)).toBe("Temporal::Namespace");
  });

  test("both entities have DECLARABLE_MARKER", () => {
    const { server, ns } = TemporalDevStack();
    expect((server as Record<symbol, unknown>)[DECLARABLE_MARKER]).toBe(true);
    expect((ns as Record<symbol, unknown>)[DECLARABLE_MARKER]).toBe(true);
  });

  test("defaults: namespace=default, retention=7d, mode=dev", () => {
    const { server, ns } = TemporalDevStack();
    expect(getProps(ns).name).toBe("default");
    expect(getProps(ns).retention).toBe("7d");
    expect(getProps(server).mode).toBe("dev");
  });

  test("config overrides namespace and retention", () => {
    const { ns } = TemporalDevStack({ namespace: "my-app", retention: "14d" });
    expect(getProps(ns).name).toBe("my-app");
    expect(getProps(ns).retention).toBe("14d");
  });

  test("config passes version and ports to server", () => {
    const { server } = TemporalDevStack({ version: "1.25.0", port: 7234, uiPort: 8081 });
    expect(getProps(server).version).toBe("1.25.0");
    expect(getProps(server).port).toBe(7234);
    expect(getProps(server).uiPort).toBe(8081);
  });

  test("description is forwarded to namespace when provided", () => {
    const { ns } = TemporalDevStack({ description: "local dev namespace" });
    expect(getProps(ns).description).toBe("local dev namespace");
  });

  test("description is absent when not provided", () => {
    const { ns } = TemporalDevStack();
    expect(getProps(ns).description).toBeUndefined();
  });
});

// ── TemporalCloudStack ───────────────────────────────────────────────

describe("TemporalCloudStack: basic", () => {
  test("returns ns and searchAttributes array", () => {
    const result = TemporalCloudStack({ namespace: "prod" });
    expect(result.ns).toBeDefined();
    expect(result.searchAttributes).toBeDefined();
  });

  test("ns has entityType Temporal::Namespace", () => {
    const { ns } = TemporalCloudStack({ namespace: "prod" });
    expect(getEntityType(ns)).toBe("Temporal::Namespace");
  });

  test("defaults retention to 30d", () => {
    const { ns } = TemporalCloudStack({ namespace: "prod" });
    expect(getProps(ns).name).toBe("prod");
    expect(getProps(ns).retention).toBe("30d");
  });

  test("custom retention is forwarded", () => {
    const { ns } = TemporalCloudStack({ namespace: "staging", retention: "14d" });
    expect(getProps(ns).retention).toBe("14d");
  });

  test("returns empty searchAttributes when none specified", () => {
    const { searchAttributes } = TemporalCloudStack({ namespace: "prod" });
    expect(searchAttributes).toHaveLength(0);
  });

  test("creates SearchAttribute entities for each entry", () => {
    const { searchAttributes } = TemporalCloudStack({
      namespace: "prod",
      searchAttributes: [
        { name: "Project", type: "Keyword" },
        { name: "Priority", type: "Int" },
      ],
    });
    expect(searchAttributes).toHaveLength(2);
    expect(getEntityType(searchAttributes[0])).toBe("Temporal::SearchAttribute");
    expect(getEntityType(searchAttributes[1])).toBe("Temporal::SearchAttribute");
  });

  test("search attributes are scoped to the namespace", () => {
    const { searchAttributes } = TemporalCloudStack({
      namespace: "prod",
      searchAttributes: [{ name: "Project", type: "Keyword" }],
    });
    expect(getProps(searchAttributes[0]).namespace).toBe("prod");
    expect(getProps(searchAttributes[0]).name).toBe("Project");
    expect(getProps(searchAttributes[0]).type).toBe("Keyword");
  });

  test("description is forwarded to namespace", () => {
    const { ns } = TemporalCloudStack({ namespace: "prod", description: "Production namespace" });
    expect(getProps(ns).description).toBe("Production namespace");
  });
});

// ── WatchOp ──────────────────────────────────────────────────────────

describe("WatchOp: shape", () => {
  test("returns op + schedule resources", () => {
    const result = WatchOp({ name: "prod-watch", env: "prod", schedule: "*/15 * * * *" });
    expect(result.op).toBeDefined();
    expect(result.schedule).toBeDefined();
  });

  test("op has entityType Temporal::Op", () => {
    const { op } = WatchOp({ name: "prod-watch", env: "prod", schedule: "*/15 * * * *" });
    expect(getEntityType(op)).toBe("Temporal::Op");
  });

  test("schedule has entityType Temporal::Schedule", () => {
    const { schedule } = WatchOp({ name: "prod-watch", env: "prod", schedule: "*/15 * * * *" });
    expect(getEntityType(schedule)).toBe("Temporal::Schedule");
  });

  test("both entities are Declarable", () => {
    const { op, schedule } = WatchOp({ name: "prod-watch", env: "prod", schedule: "*/15 * * * *" });
    expect((op as Record<symbol, unknown>)[DECLARABLE_MARKER]).toBe(true);
    expect((schedule as Record<symbol, unknown>)[DECLARABLE_MARKER]).toBe(true);
  });
});

describe("WatchOp: configuration", () => {
  test("op has Snapshot + Diff phases referencing the right activities", () => {
    const { op } = WatchOp({ name: "p", env: "prod", schedule: "*/15 * * * *" });
    const phases = (getProps(op).phases as Array<Record<string, unknown>>) ?? [];
    expect(phases.map((p) => p.name)).toEqual(["Snapshot", "Diff"]);
    const snapStep = (phases[0].steps as Array<Record<string, unknown>>)[0];
    const diffStep = (phases[1].steps as Array<Record<string, unknown>>)[0];
    expect(snapStep.fn).toBe("stateSnapshot");
    expect(diffStep.fn).toBe("stateDiff");
    expect(snapStep.args).toEqual({ env: "prod" });
    expect(diffStep.args).toEqual({ env: "prod", live: true });
  });

  test("auto-emit search attrs include Watch + Env", () => {
    const { op } = WatchOp({ name: "p", env: "prod", schedule: "* * * * *" });
    expect(getProps(op).searchAttributes).toEqual({ Watch: "true", Env: "prod" });
  });

  test("schedule.action.workflowType is camelCase + 'Workflow'", () => {
    const { schedule } = WatchOp({ name: "prod-watch", env: "prod", schedule: "* * * * *" });
    const action = (getProps(schedule).action as Record<string, unknown>);
    expect(action.workflowType).toBe("prodWatchWorkflow");
  });

  test("schedule.spec.cronExpressions carries the configured cron", () => {
    const { schedule } = WatchOp({ name: "p", env: "prod", schedule: "0 0 * * *" });
    const spec = (getProps(schedule).spec as Record<string, unknown>);
    expect(spec.cronExpressions).toEqual(["0 0 * * *"]);
  });

  test("scheduleId is `${name}-schedule`", () => {
    const { schedule } = WatchOp({ name: "prod-watch", env: "prod", schedule: "* * * * *" });
    expect(getProps(schedule).scheduleId).toBe("prod-watch-schedule");
  });

  test("taskQueue defaults to name and is shared by op + schedule", () => {
    const { op, schedule } = WatchOp({ name: "p-watch", env: "prod", schedule: "* * * * *" });
    expect(getProps(op).taskQueue).toBe("p-watch");
    expect((getProps(schedule).action as Record<string, unknown>).taskQueue).toBe("p-watch");
  });

  test("taskQueue override is honored", () => {
    const { op, schedule } = WatchOp({ name: "p", env: "prod", schedule: "* * * * *", taskQueue: "custom-q" });
    expect(getProps(op).taskQueue).toBe("custom-q");
    expect((getProps(schedule).action as Record<string, unknown>).taskQueue).toBe("custom-q");
  });

  test("live: false produces a digest-only diff step", () => {
    const { op } = WatchOp({ name: "p", env: "prod", schedule: "* * * * *", live: false });
    const phases = getProps(op).phases as Array<Record<string, unknown>>;
    const diffStep = (phases[1].steps as Array<Record<string, unknown>>)[0];
    expect(diffStep.args).toEqual({ env: "prod", live: false });
  });
});

describe("WatchOp: serialization", () => {
  test("Op serializes into a workflow.ts containing the snapshot+diff sequence and search-attr upserts", () => {
    const { op } = WatchOp({ name: "prod-watch", env: "prod", schedule: "*/15 * * * *" });
    const ops = new Map([["prod-watch", op]]) as unknown as Parameters<typeof serializeOps>[0];
    const files = serializeOps(ops);
    const wf = files["ops/prod-watch/workflow.ts"];
    expect(wf).toBeDefined();
    expect(wf).toContain('upsertSearchAttributes({"OpName":["prod-watch"],"Watch":["true"],"Env":["prod"]});');
    expect(wf).toContain('upsertSearchAttributes({ Phase: ["Snapshot"] });');
    expect(wf).toContain('upsertSearchAttributes({ Phase: ["Diff"] });');
    expect(wf).toContain("stateSnapshot(");
    expect(wf).toContain("stateDiff(");
  });
});
