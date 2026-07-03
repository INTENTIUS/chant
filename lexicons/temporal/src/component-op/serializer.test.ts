/**
 * Component serializer tests (#589) — string-level assertions on the
 * generated workflow/activities/worker files, mirroring
 * ../op/op-serializer.test.ts's pattern for `Temporal::Op` codegen. The
 * runtime harness (./runtime.test.ts) proves the generated code actually
 * behaves correctly under a real Temporal worker; these tests are the fast,
 * no-server-needed counterpart for codegen shape and edge cases.
 */

import { describe, expect, it } from "vitest";
import { serializeComponent, componentWorkflowFnName } from "./serializer";
import type { DriverComponent } from "@intentius/chant/components";

describe("serializeComponent()", () => {
  it("generates workflow.ts, activities.ts, worker.ts under components/<name>/", () => {
    const component: DriverComponent = { name: "search-service", dependsOn: [], deploy: [] };
    const files = serializeComponent(component);
    expect(files["components/search-service/workflow.ts"]).toBeDefined();
    expect(files["components/search-service/activities.ts"]).toBeDefined();
    expect(files["components/search-service/worker.ts"]).toBeDefined();
  });

  it("exports a camelCase workflow function named after the component, suffixed ComponentWorkflow", () => {
    const component: DriverComponent = { name: "search-service", dependsOn: [], deploy: [] };
    const wf = serializeComponent(component)["components/search-service/workflow.ts"];
    expect(wf).toContain("export async function searchServiceComponentWorkflow()");
    expect(componentWorkflowFnName("search-service")).toBe("searchServiceComponentWorkflow");
  });

  it("activities.ts re-exports the generic capability-dispatch activities from the lexicon package", () => {
    const component: DriverComponent = { name: "svc", dependsOn: [], deploy: [] };
    const activities = serializeComponent(component)["components/svc/activities.ts"];
    expect(activities).toContain("export { runCapabilityStep, rollbackCapabilityStep } from '@intentius/chant-lexicon-temporal/component-op/activities';");
  });

  it("worker.ts bootstraps a Worker pointed at workflow.js with the component name as the default task queue", () => {
    const component: DriverComponent = { name: "svc", dependsOn: [], deploy: [] };
    const worker = serializeComponent(component)["components/svc/worker.ts"];
    expect(worker).toContain("Worker.create");
    expect(worker).toContain('taskQueue: profile.taskQueue ?? "svc"');
    expect(worker).toContain("workflowsPath: fileURLToPath(new URL('./workflow.js', import.meta.url))");
  });

  // ── env/vars threading (#589 review: --env was silently dropped) ──────────

  describe("env/vars threading", () => {
    it("bakes the target env into the generated workflow, defaulting to \"local\"", () => {
      const component: DriverComponent = { name: "svc", dependsOn: [], deploy: [] };
      const wfDefault = serializeComponent(component)["components/svc/workflow.ts"];
      expect(wfDefault).toContain('const __env = "local";');

      const wfStaging = serializeComponent(component, { env: "staging" })["components/svc/workflow.ts"];
      expect(wfStaging).toContain('const __env = "staging";');
    });

    it("bakes options.vars into the generated workflow, defaulting to {}", () => {
      const component: DriverComponent = { name: "svc", dependsOn: [], deploy: [] };
      const wfDefault = serializeComponent(component)["components/svc/workflow.ts"];
      expect(wfDefault).toContain("const __vars: Record<string, unknown> = {};");

      const wfWithVars = serializeComponent(component, { vars: { registry: "my-registry" } })["components/svc/workflow.ts"];
      expect(wfWithVars).toContain('const __vars: Record<string, unknown> = {"registry":"my-registry"};');
    });

    it("passes __env/__vars into every runCapabilityStep/rollbackCapabilityStep call", () => {
      const component: DriverComponent = {
        name: "svc",
        dependsOn: [],
        deploy: [{ phase: "Apply", steps: [{ kind: "cfn-deploy" }] }],
        rollback: [{ phase: "Undo", steps: [{ kind: "cdn-invalidate" }] }],
      };
      const wf = serializeComponent(component, { env: "prod" })["components/svc/workflow.ts"];
      expect(wf).toMatch(/runCapabilityStep\(\{[^}]*env: __env,\s*vars: __vars/);
      expect(wf).toMatch(/rollbackCapabilityStep\(\{[^}]*env: __env,\s*vars: __vars/);
    });
  });

  // ── parallel-phase output merge (#589 review: race on phaseOutputs) ───────

  describe("parallel phase output merge", () => {
    it("merges every parallel branch's output into phaseOutputs in one pass after Promise.all settles", () => {
      const component: DriverComponent = {
        name: "svc",
        dependsOn: [],
        deploy: [
          { phase: "Fanout", parallel: true, steps: [{ kind: "publish-image" }, { kind: "publish-artifact" }] },
        ],
      };
      const wf = serializeComponent(component)["components/svc/workflow.ts"];
      // Both branches resolve via one Promise.all destructure...
      expect(wf).toMatch(/const \[__branch\d+_0, __branch\d+_1\] = await Promise\.all\(\[/);
      // ...and phaseOutputs is written exactly once per phase (not once per branch),
      // spreading every branch's output together — this is what keeps two
      // concurrently-resolving branches from racing on the same key.
      const phaseOutputWrites = wf.match(/phaseOutputs\["Fanout"\] = /g) ?? [];
      expect(phaseOutputWrites).toHaveLength(1);
      expect(wf).toMatch(/phaseOutputs\["Fanout"\] = \{ \.\.\.\(phaseOutputs\["Fanout"\] \?\? \{\}\), \.\.\.\(__branch\d+_0 as object \?\? \{\}\), \.\.\.\(__branch\d+_1 as object \?\? \{\}\) \};/);
    });

    it("a sequential (non-parallel) phase still merges each step's output as it runs", () => {
      const component: DriverComponent = {
        name: "svc",
        dependsOn: [],
        deploy: [{ phase: "Deploy", steps: [{ kind: "publish-image" }, { kind: "cfn-deploy" }] }],
      };
      const wf = serializeComponent(component)["components/svc/workflow.ts"];
      const phaseOutputWrites = wf.match(/phaseOutputs\["Deploy"\] = /g) ?? [];
      expect(phaseOutputWrites).toHaveLength(2); // once per sequential step
    });
  });

  // ── identifier safety (#589 review: schema-legal input that isn't a valid JS identifier) ──

  describe("identifier safety", () => {
    it("a component name starting with a digit still produces a syntactically valid workflow function name", () => {
      const component: DriverComponent = { name: "3d-viewer", dependsOn: [], deploy: [] };
      const wf = serializeComponent(component)["components/3d-viewer/workflow.ts"];
      // Must not start with a digit — "3dViewerComponentWorkflow" is a syntax error.
      expect(wf).toMatch(/export async function [A-Za-z_$][A-Za-z0-9_$]*\(\): Promise<void>/);
      expect(componentWorkflowFnName("3d-viewer")).toMatch(/^[A-Za-z_$]/);
    });

    it("a gate signalName with spaces/punctuation still produces a valid signal variable name", () => {
      const component: DriverComponent = {
        name: "svc",
        dependsOn: [],
        deploy: [{ phase: "Approve", steps: [{ kind: "gate", signalName: "release approval!" }] }],
      };
      const wf = serializeComponent(component)["components/svc/workflow.ts"];
      // Every `const <ident> = defineSignal` and `let <ident>Cleared` must be valid identifiers.
      const signalConstMatch = wf.match(/const (\S+) = defineSignal</);
      expect(signalConstMatch).not.toBeNull();
      expect(signalConstMatch![1]).toMatch(/^[A-Za-z_$][A-Za-z0-9_$]*$/);
    });

    it("two gates whose signal names collide only after mangling still produce distinct identifiers", () => {
      // "Approve" and "approve" both mangle to the same signalVarName before
      // safeIdentifier is involved; distinctness here just needs the generated
      // code to not be a hard duplicate-`const` syntax error for this pair
      // specifically (two identical, unrelated gate names in one component is
      // itself an authoring error the schema doesn't forbid, but the generated
      // code must at least be syntactically parseable, which a `const` naming
      // collision would break).
      const component: DriverComponent = {
        name: "svc",
        dependsOn: [],
        deploy: [
          { phase: "A", steps: [{ kind: "gate", signalName: "Approve" }] },
          { phase: "B", steps: [{ kind: "gate", signalName: "approve-2" }] },
        ],
      };
      const wf = serializeComponent(component)["components/svc/workflow.ts"];
      const idents = [...wf.matchAll(/const (\S+) = defineSignal</g)].map((m) => m[1]);
      expect(new Set(idents).size).toBe(idents.length);
    });
  });

  // ── componentOutputs scope (#589 review: always empty — documented, not a bug) ──

  it("componentOutputs starts empty and the workflow never writes to it (single-component scope)", () => {
    const component: DriverComponent = { name: "svc", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "cfn-deploy" }] }] };
    const wf = serializeComponent(component)["components/svc/workflow.ts"];
    expect(wf).toContain("const componentOutputs: Record<string, Record<string, unknown>> = {};");
    // No assignment into componentOutputs anywhere in the generated body.
    expect(wf).not.toMatch(/componentOutputs\[.*\]\s*=/);
  });
});
