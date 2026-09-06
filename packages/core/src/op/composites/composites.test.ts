/**
 * Composite unit tests (#2120) — WatchOp, ReconcileOp, ApplyOp and the
 * receipt-staleness watch, moved here with the composites themselves. The
 * serialization half of this suite stays in
 * a hosting lexicon's own composites suite: that one asserts on its
 * serializer's output, which is the lexicon's business.
 */

import { describe, test, expect } from "vitest";
import { WatchOp } from "./watch-op";
import { ReconcileOp } from "./reconcile-op";
import { ApplyOp } from "./apply-op";
import { DECLARABLE_MARKER } from "../../declarable";
import { EffectReceipt, receiptExpectation } from "../../effect-receipt";

function getProps(entity: unknown): Record<string, unknown> {
  return (entity as { props: Record<string, unknown> }).props;
}

function getEntityType(entity: unknown): string {
  return (entity as Record<string, unknown>).entityType as string;
}

// ── WatchOp ──────────────────────────────────────────────────────────

describe("WatchOp: shape", () => {
  test("returns { op } — the cadence is on the op, not a second resource (#2120)", () => {
    const result = WatchOp({ name: "prod-watch", env: "prod", schedule: "*/15 * * * *" });
    expect(result.op).toBeDefined();
    expect(Object.keys(result)).toEqual(["op"]);
  });

  test("op has entityType Chant::Op", () => {
    const { op } = WatchOp({ name: "prod-watch", env: "prod", schedule: "*/15 * * * *" });
    expect(getEntityType(op)).toBe("Chant::Op");
  });

  test("the op is Declarable", () => {
    const { op } = WatchOp({ name: "prod-watch", env: "prod", schedule: "*/15 * * * *" });
    expect((op as unknown as Record<symbol, unknown>)[DECLARABLE_MARKER]).toBe(true);
  });

  test("op.schedule carries the cron with the only overlap policy there is", () => {
    const { op } = WatchOp({ name: "prod-watch", env: "prod", schedule: "*/15 * * * *" });
    expect(getProps(op).schedule).toEqual({ cron: "*/15 * * * *", overlap: "skip" });
  });

  test("no cron: a one-shot watch, no schedule on the op", () => {
    const { op } = WatchOp({ name: "prod-watch", env: "prod" });
    expect(getProps(op).schedule).toBeUndefined();
  });

  test("an invalid cron is refused at construction with TMP010's wording", () => {
    expect(() => WatchOp({ name: "prod-watch", env: "prod", schedule: "every 15 minutes" })).toThrow(
      /does not look like valid 5- or 6-field cron syntax/,
    );
  });
});

describe("WatchOp: configuration", () => {
  test("op has Snapshot + Diff phases referencing the right activities", () => {
    const { op } = WatchOp({ name: "p", env: "prod", schedule: "*/15 * * * *" });
    const phases = (getProps(op).phases as Array<Record<string, unknown>>) ?? [];
    expect(phases.map((p) => p.name)).toEqual(["Snapshot", "Diff"]);
    const snapStep = (phases[0].steps as Array<Record<string, unknown>>)[0];
    const diffStep = (phases[1].steps as Array<Record<string, unknown>>)[0];
    expect(snapStep.fn).toBe("lifecycleSnapshot");
    expect(diffStep.fn).toBe("lifecycleDiff");
    expect(snapStep.args).toEqual({ env: "prod" });
    expect(diffStep.args).toEqual({ env: "prod", live: true });
    // Drift is surfaced as a workflow search attribute via outcomeAttribute (#41)
    expect(diffStep.outcomeAttribute).toEqual({ name: "Drift", from: "drifted" });
  });

  test("auto-emit search attrs include Watch + Env", () => {
    const { op } = WatchOp({ name: "p", env: "prod", schedule: "* * * * *" });
    expect(getProps(op).labels).toEqual({ Watch: "true", Env: "prod" });
  });

  test("the configured cron reaches op.schedule verbatim", () => {
    const { op } = WatchOp({ name: "p", env: "prod", schedule: "0 0 * * *" });
    expect((getProps(op).schedule as Record<string, unknown>).cron).toBe("0 0 * * *");
  });

  test("live: false produces a digest-only diff step", () => {
    const { op } = WatchOp({ name: "p", env: "prod", schedule: "* * * * *", live: false });
    const phases = getProps(op).phases as Array<Record<string, unknown>>;
    const diffStep = (phases[1].steps as Array<Record<string, unknown>>)[0];
    expect(diffStep.args).toEqual({ env: "prod", live: false });
  });
});

// ── ReconcileOp ──────────────────────────────────────────────────────

describe("ReconcileOp: shape", () => {
  test("one-shot (no cron) returns an op with no cadence", () => {
    const result = ReconcileOp({ name: "prod-reconcile", env: "prod" });
    expect(result.op).toBeDefined();
    expect(getProps(result.op).schedule).toBeUndefined();
    expect(getEntityType(result.op)).toBe("Chant::Op");
    expect((result.op as unknown as Record<symbol, unknown>)[DECLARABLE_MARKER]).toBe(true);
  });

  test("with a cron the op carries the schedule and nothing else is returned", () => {
    const result = ReconcileOp({ name: "prod-reconcile", env: "prod", schedule: "0 * * * *" });
    expect(Object.keys(result)).toEqual(["op"]);
    expect(getProps(result.op).schedule).toEqual({ cron: "0 * * * *", overlap: "skip" });
  });
});

describe("ReconcileOp: configuration", () => {
  test("phases are Snapshot → Plan → Reconcile with the right activities", () => {
    const { op } = ReconcileOp({ name: "p", env: "prod" });
    const phases = (getProps(op).phases as Array<Record<string, unknown>>) ?? [];
    expect(phases.map((p) => p.name)).toEqual(["Snapshot", "Plan", "Reconcile"]);
    const reconcileStep = (phases[2].steps as Array<Record<string, unknown>>)[0];
    expect(reconcileStep.fn).toBe("reconcilePr");
    expect(reconcileStep.args).toEqual({ env: "prod", mode: "pull-request", owned: false });
  });

  test("scope.owned + onDrift flow into the reconcilePr step", () => {
    const { op } = ReconcileOp({ name: "p", env: "prod", onDrift: "issue", scope: { owned: true } });
    const phases = getProps(op).phases as Array<Record<string, unknown>>;
    const reconcileStep = (phases[2].steps as Array<Record<string, unknown>>)[0];
    expect(reconcileStep.args).toEqual({ env: "prod", mode: "issue", owned: true });
  });

  test("auto-emit search attrs include Reconcile + Env", () => {
    const { op } = ReconcileOp({ name: "p", env: "prod" });
    expect(getProps(op).labels).toEqual({ Reconcile: "true", Env: "prod" });
  });

  test("Plan phase surfaces Drift as a search attribute", () => {
    const { op } = ReconcileOp({ name: "p", env: "prod" });
    const phases = getProps(op).phases as Array<Record<string, unknown>>;
    const diffStep = (phases[1].steps as Array<Record<string, unknown>>)[0];
    expect(diffStep.outcomeAttribute).toEqual({ name: "Drift", from: "drifted" });
  });
});

// ── ApplyOp ──────────────────────────────────────────────────────────

describe("ApplyOp: shape", () => {
  test("returns an op (no schedule)", () => {
    const result = ApplyOp({ name: "prod-apply", env: "prod" });
    expect(result.op).toBeDefined();
    expect(getEntityType(result.op)).toBe("Chant::Op");
    expect((result.op as unknown as Record<symbol, unknown>)[DECLARABLE_MARKER]).toBe(true);
  });

  test("ungated apply: Build → Plan → Apply (no Approve phase)", () => {
    const { op } = ApplyOp({ name: "p", env: "prod", target: "kubectl" });
    const phases = getProps(op).phases as Array<Record<string, unknown>>;
    expect(phases.map((p) => p.name)).toEqual(["Build", "Plan", "Apply"]);
    const applyStep = (phases[2].steps as Array<Record<string, unknown>>)[0];
    expect(applyStep.fn).toBe("nativeApply");
    expect(applyStep.args).toEqual({ target: "kubectl", env: "prod", output: "dist", deleteMode: "never" });
  });
});

describe("ApplyOp: gating + deletes", () => {
  test("delete: gated inserts an Approve gate phase before Apply", () => {
    const { op } = ApplyOp({ name: "p", env: "prod", delete: "gated" });
    const phases = getProps(op).phases as Array<Record<string, unknown>>;
    expect(phases.map((p) => p.name)).toEqual(["Build", "Plan", "Approve", "Apply"]);
    const gateStep = (phases[2].steps as Array<Record<string, unknown>>)[0];
    expect(gateStep.kind).toBe("gate");
    expect(gateStep.signalName).toBe("approve-p");
  });

  test("explicit gate config is honored", () => {
    const { op } = ApplyOp({
      name: "p",
      env: "prod",
      gate: { signalName: "go", description: "ship it" },
    });
    const phases = getProps(op).phases as Array<Record<string, unknown>>;
    const gateStep = (phases[2].steps as Array<Record<string, unknown>>)[0];
    expect(gateStep.signalName).toBe("go");
    expect(gateStep.description).toBe("ship it");
  });

  test("deleteMode flows into the nativeApply step", () => {
    const { op } = ApplyOp({ name: "p", env: "prod", delete: "owned-only" });
    const phases = getProps(op).phases as Array<Record<string, unknown>>;
    const applyStep = (phases.find((p) => p.name === "Apply")!.steps as Array<Record<string, unknown>>)[0];
    expect((applyStep.args as Record<string, unknown>).deleteMode).toBe("owned-only");
  });

  test("auto-emit search attrs include Apply + Env", () => {
    const { op } = ApplyOp({ name: "p", env: "prod" });
    expect(getProps(op).labels).toEqual({ Apply: "true", Env: "prod" });
  });
});

describe("ApplyOp: compensation (#125, total-or-refused in #1449)", () => {
  test("destructive apply on a target with a native rollback compensates by default", () => {
    const { op } = ApplyOp({ name: "p", env: "prod", target: "cloudformation", delete: "owned-only" });
    const onFailure = getProps(op).onFailure as Array<Record<string, unknown>> | undefined;
    expect(onFailure?.map((p) => p.name)).toEqual(["Rollback"]);
    const step = (onFailure![0].steps as Array<Record<string, unknown>>)[0];
    expect(step.fn).toBe("compensateApply");
    expect(step.args).toEqual({ target: "cloudformation", env: "prod" });
  });

  test("destructive apply on a rollback-less target has no compensation by default", () => {
    // Compensation is total: without a rollback path there is nothing the
    // phase could run, so none is wired — rather than one that could only
    // warn at rollback time.
    const { op } = ApplyOp({ name: "p", env: "prod", target: "kubectl", delete: "owned-only" });
    expect(getProps(op).onFailure).toBeUndefined();
  });

  test("additive apply has no compensation by default", () => {
    const { op } = ApplyOp({ name: "p", env: "prod", delete: "never" });
    expect(getProps(op).onFailure).toBeUndefined();
  });

  test("compensate: false disables rollback even when destructive", () => {
    const { op } = ApplyOp({
      name: "p",
      env: "prod",
      target: "cloudformation",
      delete: "owned-only",
      compensate: false,
    });
    expect(getProps(op).onFailure).toBeUndefined();
  });

  test("compensate.command supplies a rollback for targets without a native one", () => {
    const { op } = ApplyOp({
      name: "p",
      env: "prod",
      target: "kubectl",
      compensate: { command: "kubectl rollout undo deployment/web" },
    });
    const onFailure = getProps(op).onFailure as Array<Record<string, unknown>>;
    const step = (onFailure[0].steps as Array<Record<string, unknown>>)[0];
    expect((step.args as Record<string, unknown>).command).toBe("kubectl rollout undo deployment/web");
  });

  test("compensate: true on cloudformation builds — the native rollbackStack is the path", () => {
    const { op } = ApplyOp({ name: "p", env: "prod", target: "cloudformation", compensate: true });
    const onFailure = getProps(op).onFailure as Array<Record<string, unknown>>;
    const step = (onFailure[0].steps as Array<Record<string, unknown>>)[0];
    expect(step.fn).toBe("compensateApply");
    expect((step.args as Record<string, unknown>).command).toBeUndefined();
  });

  test("compensate: true is refused at build time for every rollback-less target (#1449)", () => {
    for (const target of ["kubectl", "kustomize", "arm", "gcp", "fly"] as const) {
      expect(() => ApplyOp({ name: "p", env: "prod", target, compensate: true })).toThrow(
        new RegExp(`ApplyOp "p": compensate is enabled, but target "${target}" has no automatic rollback`),
      );
    }
  });

  test("the refusal names the two ways out — compensate.command or compensate: false", () => {
    const err = (() => {
      try {
        ApplyOp({ name: "web-apply", env: "prod", target: "fly", compensate: true });
        return undefined;
      } catch (e) {
        return String(e);
      }
    })();
    expect(err).toMatch(/compensate: \{ command/);
    expect(err).toMatch(/compensate: false/);
    expect(err).toMatch(/rollbackStack/);
  });

  test("an object without a command is refused the same way as true", () => {
    for (const target of ["kubectl", "kustomize", "arm", "gcp", "fly"] as const) {
      expect(() => ApplyOp({ name: "p", env: "prod", target, compensate: {} })).toThrow(
        /has no automatic rollback/,
      );
    }
  });

  test("a command lifts the refusal on every target", () => {
    for (const target of ["kubectl", "kustomize", "arm", "gcp", "fly", "cloudformation"] as const) {
      const { op } = ApplyOp({
        name: "p",
        env: "prod",
        target,
        compensate: { command: "echo rollback" },
      });
      const onFailure = getProps(op).onFailure as Array<Record<string, unknown>>;
      const step = (onFailure[0].steps as Array<Record<string, unknown>>)[0];
      expect((step.args as Record<string, unknown>).command).toBe("echo rollback");
    }
  });
});

// ── ApplyOp: gated effects (#1834) ───────────────────────────────────

describe("ApplyOp: effects gated (#1834, #1703 decision 6)", () => {
  test("effects: gated inserts the Approve gate phase before Apply, like delete: gated", () => {
    const { op } = ApplyOp({ name: "p", env: "prod", effects: "gated" });
    const phases = getProps(op).phases as Array<Record<string, unknown>>;
    expect(phases.map((p) => p.name)).toEqual(["Build", "Plan", "Approve", "Apply"]);
    const gateStep = (phases[2].steps as Array<Record<string, unknown>>)[0];
    expect(gateStep.kind).toBe("gate");
    expect(gateStep.signalName).toBe("approve-p");
    expect(gateStep.description).toBe("Approve apply to prod (delete mode: never, effects: gated)");
  });

  test("effects: gated does not change the delete mode riding into nativeApply", () => {
    const { op } = ApplyOp({ name: "p", env: "prod", effects: "gated" });
    const phases = getProps(op).phases as Array<Record<string, unknown>>;
    const applyStep = (phases.find((p) => p.name === "Apply")!.steps as Array<Record<string, unknown>>)[0];
    expect((applyStep.args as Record<string, unknown>).deleteMode).toBe("never");
  });

  test("effects: gated composes with delete: gated in one Approve gate", () => {
    const { op } = ApplyOp({ name: "p", env: "prod", delete: "gated", effects: "gated" });
    const phases = getProps(op).phases as Array<Record<string, unknown>>;
    expect(phases.map((p) => p.name)).toEqual(["Build", "Plan", "Approve", "Apply"]);
    const gateStep = (phases[2].steps as Array<Record<string, unknown>>)[0];
    expect(gateStep.description).toBe("Approve apply to prod (delete mode: gated, effects: gated)");
  });

});

// ── WatchOp: receipt staleness (#1834) ───────────────────────────────

describe("WatchOp: receipt staleness (#1834)", () => {
  const seeded = EffectReceipt("seeded", {
    effect: "db-seed",
    flavor: "hash",
    inputs: { file: "seed.sql" },
  });

  test("without receipts the op is unchanged (no Receipts phase)", () => {
    const { op } = WatchOp({ name: "p", env: "prod", schedule: "* * * * *" });
    const phases = getProps(op).phases as Array<Record<string, unknown>>;
    expect(phases.map((p) => p.name)).toEqual(["Snapshot", "Diff"]);
  });

  test("receipts add a read-only Receipts phase carrying identity + expectation data", () => {
    const { op } = WatchOp({ name: "p", env: "prod", schedule: "* * * * *", receipts: [seeded] });
    const phases = getProps(op).phases as Array<Record<string, unknown>>;
    expect(phases.map((p) => p.name)).toEqual(["Snapshot", "Diff", "Receipts"]);
    const step = (phases[2].steps as Array<Record<string, unknown>>)[0];
    expect(step.fn).toBe("receiptStaleness");
    expect(step.args).toEqual({
      receipts: [
        {
          receipt: { name: "seeded", effect: "db-seed", flavor: "hash", inputs: { file: "seed.sql" } },
          expectation: receiptExpectation(seeded),
        },
      ],
    });
    // Staleness surfaces as a workflow search attribute, like Drift.
    expect(step.outcomeAttribute).toEqual({ name: "StaleReceipts", from: "stale" });
  });

  test("the Receipts phase runs nothing: its only step is the staleness read", () => {
    const { op } = WatchOp({ name: "p", env: "prod", schedule: "* * * * *", receipts: [seeded] });
    const phases = getProps(op).phases as Array<Record<string, unknown>>;
    const steps = phases[2].steps as Array<Record<string, unknown>>;
    expect(steps).toHaveLength(1);
    expect(steps.map((s) => s.fn)).toEqual(["receiptStaleness"]);
  });

});
