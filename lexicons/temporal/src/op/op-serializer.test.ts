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

    it("passes the whole profile object to proxyActivities (carries every retry field, incl. nonRetryableErrorTypes)", () => {
      // The worker must spread the entire profile — not a hand-picked subset of
      // fields — so retry policy reaches Temporal's ActivityOptions intact. This
      // is what makes the --temporal path honor nonRetryableErrorTypes the same
      // way the local executor does. Reconstructing the options inline would
      // silently drop any field not explicitly copied; this locks that out.
      const ops = new Map([
        makeOp({
          name: "deploy", overview: "o",
          phases: [{ name: "Build", steps: [{ kind: "activity", fn: "chantBuild", args: { path: "./a" } }] }],
        }),
      ]);
      const wf = serializeOps(ops)["ops/deploy/workflow.ts"];
      expect(wf).toMatch(/proxyActivities<typeof activities>\(\s*TEMPORAL_ACTIVITY_PROFILES\.fastIdempotent,\s*\)/);
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

    it("renders onFailure compensation phases after main phases", () => {
      const ops = new Map([
        makeOp({
          name: "safe-op", overview: "o",
          phases: [
            { name: "Deploy", steps: [{ kind: "activity", fn: "helmInstall", args: { name: "r", chart: "c" } }] },
          ],
          onFailure: [
            { name: "Rollback", steps: [{ kind: "activity", fn: "helmInstall", args: { name: "r", chart: "c" } }] },
          ],
        }),
      ]);
      const wf = serializeOps(ops)["ops/safe-op/workflow.ts"];
      expect(wf).toContain("onFailure compensation");
      expect(wf).toContain("// Phase: Rollback");
    });

    it("runs onFailure compensation ONLY on failure: main phases are wrapped in try/catch (#168)", () => {
      const ops = new Map([
        makeOp({
          name: "deploy", overview: "o",
          phases: [{ name: "Apply", steps: [{ kind: "activity", fn: "helmInstall", args: { name: "r", chart: "c" } }] }],
          onFailure: [{ name: "Rollback", steps: [{ kind: "activity", fn: "helmInstall", args: { name: "r", chart: "c" } }] }],
        }),
      ]);
      const wf = serializeOps(ops)["ops/deploy/workflow.ts"];
      // Main phase guarded; compensation lives in the catch and re-throws the original error.
      expect(wf).toContain("try {");
      expect(wf).toContain("} catch (__opErr) {");
      expect(wf).toContain("throw __opErr;");
      // The compensation Phase upsert must appear after the catch opens, never before.
      expect(wf.indexOf("catch (__opErr)")).toBeLessThan(wf.indexOf('Phase: ["Rollback"]'));
    });

    it("has no try/catch when there is no onFailure (#168)", () => {
      const ops = new Map([
        makeOp({
          name: "plain", overview: "o",
          phases: [{ name: "Apply", steps: [{ kind: "activity", fn: "helmInstall", args: { name: "r", chart: "c" } }] }],
        }),
      ]);
      const wf = serializeOps(ops)["ops/plain/workflow.ts"];
      expect(wf).not.toContain("catch (__opErr)");
    });

    it("runs onFailure phases in reverse order, matching the local executor (#168)", () => {
      const ops = new Map([
        makeOp({
          name: "deploy", overview: "o",
          phases: [{ name: "Apply", steps: [] }],
          onFailure: [
            { name: "Rollback", steps: [] },
            { name: "Notify", steps: [] },
          ],
        }),
      ]);
      const wf = serializeOps(ops)["ops/deploy/workflow.ts"];
      // Declared order Rollback→Notify, so compensation emits Notify before Rollback.
      expect(wf.indexOf('Phase: ["Notify"]')).toBeLessThan(wf.indexOf('Phase: ["Rollback"]'));
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

  // ── Auto-emit upsertSearchAttributes (#28) ──────────────────────────────────

  describe("upsertSearchAttributes auto-emit", () => {
    function countOccurrences(haystack: string, needle: string): number {
      return haystack.split(needle).length - 1;
    }

    it("imports upsertSearchAttributes from @temporalio/workflow", () => {
      const ops = new Map([
        makeOp({ name: "op", overview: "o", phases: [{ name: "Phase1", steps: [] }] }),
      ]);
      const wf = serializeOps(ops)["ops/op/workflow.ts"];
      expect(wf).toMatch(
        /import \{[^}]*\bupsertSearchAttributes\b[^}]*\} from '@temporalio\/workflow'/,
      );
    });

    it("3-phase Op with no searchAttributes emits exactly 4 upsert calls", () => {
      const ops = new Map([
        makeOp({
          name: "deploy",
          overview: "o",
          phases: [
            { name: "init", steps: [] },
            { name: "apply", steps: [] },
            { name: "verify", steps: [] },
          ],
        }),
      ]);
      const wf = serializeOps(ops)["ops/deploy/workflow.ts"];

      expect(countOccurrences(wf, "upsertSearchAttributes(")).toBe(4);
      // Initial call: OpName only, no Phase yet
      expect(wf).toContain('upsertSearchAttributes({"OpName":["deploy"]});');
      // Phase upserts at each phase boundary
      expect(wf).toContain('upsertSearchAttributes({ Phase: ["init"] });');
      expect(wf).toContain('upsertSearchAttributes({ Phase: ["apply"] });');
      expect(wf).toContain('upsertSearchAttributes({ Phase: ["verify"] });');
    });

    it("merges user-provided searchAttributes into the initial call (each value as a 1-element array)", () => {
      const ops = new Map([
        makeOp({
          name: "deploy",
          overview: "o",
          phases: [{ name: "Build", steps: [] }],
          searchAttributes: { Region: "us-east-1", Environment: "prod" },
        }),
      ]);
      const wf = serializeOps(ops)["ops/deploy/workflow.ts"];

      expect(wf).toContain(
        'upsertSearchAttributes({"OpName":["deploy"],"Region":["us-east-1"],"Environment":["prod"]});',
      );
    });

    it("single-phase Op produces exactly 2 upsert calls", () => {
      const ops = new Map([
        makeOp({
          name: "tiny",
          overview: "o",
          phases: [{ name: "Only", steps: [] }],
        }),
      ]);
      const wf = serializeOps(ops)["ops/tiny/workflow.ts"];

      expect(countOccurrences(wf, "upsertSearchAttributes(")).toBe(2);
    });

    it("emits Phase upserts inside onFailure compensation phases", () => {
      const ops = new Map([
        makeOp({
          name: "deploy",
          overview: "o",
          phases: [{ name: "Apply", steps: [] }],
          onFailure: [
            { name: "Rollback", steps: [] },
            { name: "Notify", steps: [] },
          ],
        }),
      ]);
      const wf = serializeOps(ops)["ops/deploy/workflow.ts"];

      // 1 initial + 1 Apply + 2 onFailure phases = 4
      expect(countOccurrences(wf, "upsertSearchAttributes(")).toBe(4);
      expect(wf).toContain('upsertSearchAttributes({ Phase: ["Rollback"] });');
      expect(wf).toContain('upsertSearchAttributes({ Phase: ["Notify"] });');
    });
  });

  // ── outcomeAttribute (#41) ──────────────────────────────────────────────────

  describe("outcomeAttribute auto-emit", () => {
    it("captures activity result and emits an upsert with from-path", () => {
      const ops = new Map([
        makeOp({
          name: "watch",
          overview: "watch",
          phases: [
            {
              name: "Diff",
              steps: [
                { kind: "activity", fn: "lifecycleDiff", args: { env: "prod" }, outcomeAttribute: { name: "Drift", from: "drifted" } },
              ],
            },
          ],
        }),
      ]);
      const wf = serializeOps(ops)["ops/watch/workflow.ts"];
      expect(wf).toContain('const __r0 = await lifecycleDiff({"env":"prod"});');
      expect(wf).toContain('upsertSearchAttributes({ "Drift": [String(__r0?.drifted)] });');
    });

    it("stringifies whole result when from is omitted", () => {
      const ops = new Map([
        makeOp({
          name: "watch",
          overview: "watch",
          phases: [
            {
              name: "Check",
              steps: [
                { kind: "activity", fn: "checkSomething", outcomeAttribute: { name: "Status" } },
              ],
            },
          ],
        }),
      ]);
      const wf = serializeOps(ops)["ops/watch/workflow.ts"];
      expect(wf).toContain('upsertSearchAttributes({ "Status": [String(__r0)] });');
    });

    it("nested from-path uses optional-chain stringify", () => {
      const ops = new Map([
        makeOp({
          name: "watch",
          overview: "watch",
          phases: [
            {
              name: "Inspect",
              steps: [
                { kind: "activity", fn: "deepInspect", outcomeAttribute: { name: "Ok", from: "result.healthy" } },
              ],
            },
          ],
        }),
      ]);
      const wf = serializeOps(ops)["ops/watch/workflow.ts"];
      expect(wf).toContain('upsertSearchAttributes({ "Ok": [String(__r0?.result?.healthy)] });');
    });

    it("counter is workflow-scoped: multiple outcome attrs use __r0, __r1, ...", () => {
      const ops = new Map([
        makeOp({
          name: "watch",
          overview: "watch",
          phases: [
            { name: "A", steps: [{ kind: "activity", fn: "first", outcomeAttribute: { name: "FirstResult" } }] },
            { name: "B", steps: [{ kind: "activity", fn: "second", outcomeAttribute: { name: "SecondResult" } }] },
          ],
        }),
      ]);
      const wf = serializeOps(ops)["ops/watch/workflow.ts"];
      expect(wf).toContain("const __r0 = await first(");
      expect(wf).toContain("const __r1 = await second(");
      expect(wf).toContain('upsertSearchAttributes({ "FirstResult": [String(__r0)] });');
      expect(wf).toContain('upsertSearchAttributes({ "SecondResult": [String(__r1)] });');
    });

    it("activities without outcomeAttribute keep the bare-await form", () => {
      const ops = new Map([
        makeOp({
          name: "mixed",
          overview: "mixed",
          phases: [
            {
              name: "Mix",
              steps: [
                { kind: "activity", fn: "noOutcome" },
                { kind: "activity", fn: "withOutcome", outcomeAttribute: { name: "Result" } },
              ],
            },
          ],
        }),
      ]);
      const wf = serializeOps(ops)["ops/mixed/workflow.ts"];
      expect(wf).toContain("await noOutcome({});");
      expect(wf).toContain("const __r0 = await withOutcome({});");
    });

    it("parallel phase with outcome attrs destructures Promise.all results", () => {
      const ops = new Map([
        makeOp({
          name: "fan",
          overview: "fan",
          phases: [
            {
              name: "Parallel",
              parallel: true,
              steps: [
                { kind: "activity", fn: "alpha", outcomeAttribute: { name: "AlphaOk", from: "ok" } },
                { kind: "activity", fn: "beta", outcomeAttribute: { name: "BetaOk", from: "ok" } },
              ],
            },
          ],
        }),
      ]);
      const wf = serializeOps(ops)["ops/fan/workflow.ts"];
      expect(wf).toContain("const [__r0, __r1] = await Promise.all([");
      expect(wf).toContain('upsertSearchAttributes({ "AlphaOk": [String(__r0?.ok)] });');
      expect(wf).toContain('upsertSearchAttributes({ "BetaOk": [String(__r1?.ok)] });');
    });
  });
});
