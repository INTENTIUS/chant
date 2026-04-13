/**
 * Op serializer tests — verifies that Temporal::Op entities generate
 * the correct workflow.ts, activities.ts, and worker.ts files.
 */

import { describe, expect, it } from "vitest";
import { serializeOps } from "./serializer";
import { DECLARABLE_MARKER } from "@intentius/chant/declarable";
import type { OpConfig } from "@intentius/chant/op";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeOp(config: OpConfig): [string, Record<string, unknown>] {
  return [
    config.name,
    {
      [DECLARABLE_MARKER]: true,
      entityType: "Temporal::Op",
      lexicon: "temporal",
      kind: "resource",
      props: config,
      attributes: {},
    },
  ];
}

// ── Basic generation ──────────────────────────────────────────────────────────

describe("serializeOps()", () => {
  it("returns empty object for empty map", () => {
    expect(serializeOps(new Map())).toEqual({});
  });

  it("generates workflow.ts, activities.ts, worker.ts for each Op", () => {
    const ops = new Map([
      makeOp({ name: "alb-deploy", overview: "ALB deploy", phases: [] }),
    ]);
    const files = serializeOps(ops);
    expect(files["ops/alb-deploy/workflow.ts"]).toBeDefined();
    expect(files["ops/alb-deploy/activities.ts"]).toBeDefined();
    expect(files["ops/alb-deploy/worker.ts"]).toBeDefined();
  });

  it("generates files for multiple Ops under separate directories", () => {
    const ops = new Map([
      makeOp({ name: "op-a", overview: "A", phases: [] }),
      makeOp({ name: "op-b", overview: "B", phases: [] }),
    ]);
    const files = serializeOps(ops);
    expect(files["ops/op-a/workflow.ts"]).toBeDefined();
    expect(files["ops/op-b/workflow.ts"]).toBeDefined();
  });

  // ── workflow.ts ─────────────────────────────────────────────────────────────

  describe("workflow.ts", () => {
    it("exports a camelCase workflow function named after the Op", () => {
      const ops = new Map([
        makeOp({ name: "alb-deploy", overview: "o", phases: [] }),
      ]);
      const wf = serializeOps(ops)["ops/alb-deploy/workflow.ts"];
      expect(wf).toContain("export async function albDeployWorkflow()");
    });

    it("imports proxyActivities, condition, defineSignal, setHandler from @temporalio/workflow", () => {
      const ops = new Map([makeOp({ name: "my-op", overview: "o", phases: [] })]);
      const wf = serializeOps(ops)["ops/my-op/workflow.ts"];
      expect(wf).toContain("from '@temporalio/workflow'");
      expect(wf).toContain("proxyActivities");
      expect(wf).toContain("condition");
      expect(wf).toContain("defineSignal");
      expect(wf).toContain("setHandler");
    });

    it("imports TEMPORAL_ACTIVITY_PROFILES from @intentius/chant-lexicon-temporal", () => {
      const ops = new Map([makeOp({ name: "my-op", overview: "o", phases: [] })]);
      const wf = serializeOps(ops)["ops/my-op/workflow.ts"];
      expect(wf).toContain("TEMPORAL_ACTIVITY_PROFILES");
      expect(wf).toContain("@intentius/chant-lexicon-temporal");
    });

    it("groups activities by profile in proxyActivities calls", () => {
      const ops = new Map([
        makeOp({
          name: "deploy", overview: "o",
          phases: [
            { name: "Build", steps: [{ kind: "activity", fn: "chantBuild", args: { path: "./a" } }] },
            { name: "Deploy", steps: [{ kind: "activity", fn: "helmInstall", args: { name: "r", chart: "c" }, profile: "longInfra" }] },
          ],
        }),
      ]);
      const wf = serializeOps(ops)["ops/deploy/workflow.ts"];
      expect(wf).toContain("TEMPORAL_ACTIVITY_PROFILES.fastIdempotent");
      expect(wf).toContain("TEMPORAL_ACTIVITY_PROFILES.longInfra");
    });

    it("generates sequential await calls for a non-parallel phase", () => {
      const ops = new Map([
        makeOp({
          name: "seq-op", overview: "o",
          phases: [{
            name: "Deploy",
            steps: [
              { kind: "activity", fn: "chantBuild", args: { path: "./a" } },
              { kind: "activity", fn: "kubectlApply", args: { manifest: "out.yaml" }, profile: "longInfra" },
            ],
          }],
        }),
      ]);
      const wf = serializeOps(ops)["ops/seq-op/workflow.ts"];
      expect(wf).toContain("await chantBuild(");
      expect(wf).toContain("await kubectlApply(");
      expect(wf).not.toContain("Promise.all");
    });

    it("generates Promise.all for a parallel phase", () => {
      const ops = new Map([
        makeOp({
          name: "par-op", overview: "o",
          phases: [{
            name: "Build",
            parallel: true,
            steps: [
              { kind: "activity", fn: "chantBuild", args: { path: "./a" } },
              { kind: "activity", fn: "chantBuild", args: { path: "./b" } },
            ],
          }],
        }),
      ]);
      const wf = serializeOps(ops)["ops/par-op/workflow.ts"];
      expect(wf).toContain("Promise.all");
      expect(wf).toContain("chantBuild({");
    });

    it("generates gate: defineSignal, setHandler, condition", () => {
      const ops = new Map([
        makeOp({
          name: "gate-op", overview: "o",
          phases: [{
            name: "Approval",
            steps: [{ kind: "gate", signalName: "gate-dns-delegation", timeout: "48h" }],
          }],
        }),
      ]);
      const wf = serializeOps(ops)["ops/gate-op/workflow.ts"];
      expect(wf).toContain("defineSignal");
      expect(wf).toContain('"gate-dns-delegation"');
      expect(wf).toContain("setHandler");
      expect(wf).toContain("condition");
      expect(wf).toContain('"48h"');
    });

    it("uses 48h as default gate timeout when not specified", () => {
      const ops = new Map([
        makeOp({
          name: "gate-op", overview: "o",
          phases: [{ name: "Wait", steps: [{ kind: "gate", signalName: "my-signal" }] }],
        }),
      ]);
      const wf = serializeOps(ops)["ops/gate-op/workflow.ts"];
      expect(wf).toContain('"48h"');
    });

    it("uses kebab-to-camel for signal handler variable name", () => {
      const ops = new Map([
        makeOp({
          name: "op", overview: "o",
          phases: [{ name: "W", steps: [{ kind: "gate", signalName: "gate-dns-delegation" }] }],
        }),
      ]);
      const wf = serializeOps(ops)["ops/op/workflow.ts"];
      // "gate-dns-delegation" → resumeDnsDelegation
      expect(wf).toContain("resumeDnsDelegation");
    });

    it("passes activity args as JSON object", () => {
      const ops = new Map([
        makeOp({
          name: "op", overview: "o",
          phases: [{ name: "P", steps: [{ kind: "activity", fn: "chantBuild", args: { path: "my/path" } }] }],
        }),
      ]);
      const wf = serializeOps(ops)["ops/op/workflow.ts"];
      expect(wf).toContain('"path":"my/path"');
    });

    it("includes phase comment for each phase", () => {
      const ops = new Map([
        makeOp({
          name: "op", overview: "o",
          phases: [{ name: "Build and Test", steps: [{ kind: "activity", fn: "chantBuild", args: { path: "./" } }] }],
        }),
      ]);
      const wf = serializeOps(ops)["ops/op/workflow.ts"];
      expect(wf).toContain("// Phase: Build and Test");
    });
  });

  // ── activities.ts ───────────────────────────────────────────────────────────

  describe("activities.ts", () => {
    it("re-exports from @intentius/chant-lexicon-temporal/op/activities", () => {
      const ops = new Map([makeOp({ name: "op", overview: "o", phases: [] })]);
      const act = serializeOps(ops)["ops/op/activities.ts"];
      expect(act).toContain("export * from '@intentius/chant-lexicon-temporal/op/activities'");
    });
  });

  // ── worker.ts ───────────────────────────────────────────────────────────────

  describe("worker.ts", () => {
    it("imports Worker and NativeConnection from @temporalio/worker", () => {
      const ops = new Map([makeOp({ name: "op", overview: "o", phases: [] })]);
      const w = serializeOps(ops)["ops/op/worker.ts"];
      expect(w).toContain("@temporalio/worker");
      expect(w).toContain("Worker");
      expect(w).toContain("NativeConnection");
    });

    it("reads chant.config.js (relative import from ops/<name>/)", () => {
      const ops = new Map([makeOp({ name: "op", overview: "o", phases: [] })]);
      const w = serializeOps(ops)["ops/op/worker.ts"];
      expect(w).toContain("chant.config.js");
      expect(w).toContain("../../chant.config.js");
    });

    it("uses op name as default task queue when taskQueue not specified", () => {
      const ops = new Map([makeOp({ name: "alb-deploy", overview: "o", phases: [] })]);
      const w = serializeOps(ops)["ops/alb-deploy/worker.ts"];
      expect(w).toContain("alb-deploy");
    });

    it("uses custom taskQueue when specified", () => {
      const ops = new Map([makeOp({ name: "my-op", overview: "o", phases: [], taskQueue: "custom-q" })]);
      const w = serializeOps(ops)["ops/my-op/worker.ts"];
      expect(w).toContain("custom-q");
    });

    it("references workflow.js (compiled JS) not workflow.ts", () => {
      const ops = new Map([makeOp({ name: "op", overview: "o", phases: [] })]);
      const w = serializeOps(ops)["ops/op/worker.ts"];
      expect(w).toContain("./workflow.js");
    });

    it("imports activities from ./activities.js", () => {
      const ops = new Map([makeOp({ name: "op", overview: "o", phases: [] })]);
      const w = serializeOps(ops)["ops/op/worker.ts"];
      expect(w).toContain("./activities.js");
    });

    it("resolves TLS and apiKey from profile", () => {
      const ops = new Map([makeOp({ name: "op", overview: "o", phases: [] })]);
      const w = serializeOps(ops)["ops/op/worker.ts"];
      expect(w).toContain("profile.tls");
      expect(w).toContain("apiKey");
    });
  });

  // ── depends validation ──────────────────────────────────────────────────────

  describe("depends validation", () => {
    it("accepts depends on known Op names", () => {
      const ops = new Map([
        makeOp({ name: "first", overview: "o", phases: [] }),
        makeOp({ name: "second", overview: "o", phases: [], depends: ["first"] }),
      ]);
      expect(() => serializeOps(ops)).not.toThrow();
    });

    it("throws when depends references an unknown Op name", () => {
      const ops = new Map([
        makeOp({ name: "op", overview: "o", phases: [], depends: ["nonexistent-op"] }),
      ]);
      expect(() => serializeOps(ops)).toThrow(/nonexistent-op/);
    });
  });
});
