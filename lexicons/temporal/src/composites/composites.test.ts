/**
 * Composite unit tests — TemporalDevStack and TemporalCloudStack, plus the
 * serialization half of the Op composites: those live in core now (#2120,
 * `packages/core/src/op/composites/`) but what they serialize *to* is this
 * lexicon's workflow codegen, so the assertions on generated `workflow.ts`
 * belong here. Their shape tests moved with them.
 */

import { describe, test, expect } from "vitest";
import { TemporalDevStack } from "./dev-stack";
import { TemporalCloudStack } from "./cloud-stack";
import { WatchOp } from "./watch-op";
import { ApplyOp } from "./apply-op";
import { serializeOps } from "../op/serializer";
import { DECLARABLE_MARKER } from "@intentius/chant/declarable";
import { EffectReceipt, receiptExpectation } from "@intentius/chant/effect-receipt";

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

// ── Op composites: serialization (#2120) ─────────────────────────────

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
    expect(wf).toContain("lifecycleSnapshot(");
    // Diff result captured + Drift search attribute auto-emitted
    expect(wf).toContain("const __r0 = await lifecycleDiff(");
    expect(wf).toContain('upsertSearchAttributes({ "Drift": [String(__r0?.drifted)] });');
  });
});

describe("ApplyOp: gated effects serialize to a durable condition wait", () => {
  test("gated effects serialize to a durable condition wait before the apply", () => {
    const { op } = ApplyOp({ name: "prod-apply", env: "prod", effects: "gated" });
    const ops = new Map([["prod-apply", op]]) as unknown as Parameters<typeof serializeOps>[0];
    const wf = serializeOps(ops)["ops/prod-apply/workflow.ts"];
    const gateIdx = wf.indexOf("await condition(() => resumeApproveProdApplyCleared");
    const applyIdx = wf.indexOf("await nativeApply(");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(applyIdx).toBeGreaterThan(gateIdx);
  });
});

describe("WatchOp: receipt staleness serialization (#1834)", () => {
  const seeded = EffectReceipt("seeded", {
    effect: "db-seed",
    flavor: "hash",
    inputs: { file: "seed.sql" },
  });

  test("serializes into a staleness read with a StaleReceipts upsert and no receiptWrite", () => {
    const { op } = WatchOp({ name: "prod-watch", env: "prod", schedule: "* * * * *", receipts: [seeded] });
    const ops = new Map([["prod-watch", op]]) as unknown as Parameters<typeof serializeOps>[0];
    const wf = serializeOps(ops)["ops/prod-watch/workflow.ts"];
    expect(wf).toContain('upsertSearchAttributes({ Phase: ["Receipts"] });');
    expect(wf).toContain("await receiptStaleness(");
    expect(wf).toContain('upsertSearchAttributes({ "StaleReceipts": [String(__r1?.stale)] });');
    expect(wf).not.toContain("receiptWrite");
  });
});
