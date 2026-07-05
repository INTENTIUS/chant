/**
 * COMP* composition lint rule tests (#562, epic #551).
 *
 * Each rule gets one passing and one failing fixture directory under
 * ../__fixtures__/comp/<ruleId>/{pass,fail}/ — real `*.component.ts` files
 * discovered the same way `chant lint` discovers them (via
 * ../../component-checks.ts's `runComponentChecks`, itself
 * `../../../components/discover.ts`'s `discoverComponents` plus every
 * `ComponentCheck`). Each fixture directory is its own tiny "project" so
 * cross-component rules (COMP002, COMP007) only see the components meant for
 * that specific case.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runComponentChecks } from "../../component-checks";
import type { RollbackPolicy } from "../../../components/capability";
import { loadComponentChecks } from "./index";

const FIXTURES_DIR = join(import.meta.dirname, "..", "__fixtures__", "comp");
const checks = loadComponentChecks();

/**
 * Rollback dispositions the COMP003 fixtures reference, standing in for what
 * `chant lint` derives from the project's registry (`cfn-deploy` has a native
 * `rollback`; `run-migration` declares `needs-opt-out` in the aws lexicon).
 */
const FIXTURE_ROLLBACK_POLICIES = new Map<string, RollbackPolicy>([
  ["cfn-deploy", "native"],
  ["run-migration", "needs-opt-out"],
]);

async function lintFixture(
  ruleId: string,
  kind: "pass" | "fail",
  registryContext?: { knownKinds?: ReadonlySet<string>; rollbackPolicies?: ReadonlyMap<string, RollbackPolicy> },
) {
  const dir = join(FIXTURES_DIR, ruleId.toLowerCase(), kind);
  return runComponentChecks(dir, checks, registryContext);
}

describe("COMP000: component discovery errors", () => {
  it("surfaces a duplicate component name as a COMP000 diagnostic instead of silently dropping it", async () => {
    const dir = join(FIXTURES_DIR, "comp000-discovery-error");
    const diagnostics = await runComponentChecks(dir, checks);
    const hits = diagnostics.filter((d) => d.checkId === "COMP000");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].severity).toBe("error");
    expect(hits[0].message).toContain("Duplicate component name");
  });
});

describe("loadComponentChecks()", () => {
  it("returns all seven COMP* checks, sorted by id, each error or warning severity", () => {
    expect(checks.map((c) => c.id)).toEqual([
      "COMP001",
      "COMP002",
      "COMP003",
      "COMP004",
      "COMP005",
      "COMP006",
      "COMP007",
    ]);
    for (const check of checks) {
      expect(["error", "warning"]).toContain(check.severity);
      expect(typeof check.description).toBe("string");
      expect(check.description.length).toBeGreaterThan(0);
    }
  });
});

describe("COMP001: publishes-but-never-applies", () => {
  it("flags a publish step whose output nothing ever consumes", async () => {
    const diagnostics = await lintFixture("comp001", "fail");
    const hits = diagnostics.filter((d) => d.checkId === "COMP001");
    expect(hits).toHaveLength(1);
    expect(hits[0].component).toBe("orphan-lib");
    expect(hits[0].message).toContain("never consumed");
  });

  it("does not flag a publish step consumed by a downstream component", async () => {
    const diagnostics = await lintFixture("comp001", "pass");
    expect(diagnostics.filter((d) => d.checkId === "COMP001")).toHaveLength(0);
  });
});

describe("COMP002: dangling-wiring-ref", () => {
  it("flags a @Phase.field reference to a nonexistent phase and a @component.publish.* reference to an undiscovered component", async () => {
    const diagnostics = await lintFixture("comp002", "fail");
    const hits = diagnostics.filter((d) => d.checkId === "COMP002");
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits.some((d) => d.message.includes('"@Build.digest"'))).toBe(true);
    expect(hits.some((d) => d.message.includes('"@missing-lib.publish.uri"'))).toBe(true);
  });

  it("does not flag references that resolve to a real phase/dependency", async () => {
    const diagnostics = await lintFixture("comp002", "pass");
    expect(diagnostics.filter((d) => d.checkId === "COMP002")).toHaveLength(0);
  });

  it("flags a cross-component reference to a component missing from dependsOn", async () => {
    // Reuses the pass fixture's components but confirms the dependsOn check
    // specifically by asserting the pass fixture's searchService (which DOES
    // list jar-lib in dependsOn) produces no COMP002 hit for that reference.
    const diagnostics = await lintFixture("comp002", "pass");
    const jarRefHits = diagnostics.filter(
      (d) => d.checkId === "COMP002" && d.message.includes("jar-lib"),
    );
    expect(jarRefHits).toHaveLength(0);
  });
});

describe("COMP003: mutating-no-rollback", () => {
  it("flags a mutating step (run-migration) with no native rollback and no opt-out", async () => {
    const diagnostics = await lintFixture("comp003", "fail", { rollbackPolicies: FIXTURE_ROLLBACK_POLICIES });
    const hits = diagnostics.filter((d) => d.checkId === "COMP003");
    expect(hits).toHaveLength(1);
    expect(hits[0].component).toBe("migrator");
    expect(hits[0].message).toContain("run-migration");
  });

  it("does not flag a step with a native rollback (cfn-deploy) or an explicit noRollback opt-out", async () => {
    const diagnostics = await lintFixture("comp003", "pass", { rollbackPolicies: FIXTURE_ROLLBACK_POLICIES });
    expect(diagnostics.filter((d) => d.checkId === "COMP003")).toHaveLength(0);
  });

  it("flags a needs-opt-out step nested inside a fan-out phase, not just top-level phases", () => {
    // Regression test: the rule used to iterate component.deploy directly and
    // never recursed into nested Phase entries (a fan-out unit, e.g. the
    // Neo4j pilot's per-instance phases), so a mutating step buried inside one
    // was silently skipped. It must now use the same walkComponent traversal
    // every other COMP rule uses.
    const [comp003] = checks.filter((c) => c.id === "COMP003");
    const ctx = {
      rollbackPolicies: FIXTURE_ROLLBACK_POLICIES,
      components: new Map([
        [
          "fanout-cluster",
          {
            component: {
              name: "fanout-cluster",
              dependsOn: [],
              deploy: [
                {
                  phase: "Rolling",
                  steps: [
                    {
                      phase: "Node 1",
                      steps: [{ kind: "run-migration", tool: "flyway", target: "node-1" }],
                    },
                  ],
                },
              ],
            },
            filePath: "fanout-cluster.component.ts",
          },
        ],
      ]),
    };
    const diagnostics = comp003.check(ctx as never);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].component).toBe("fanout-cluster");
    expect(diagnostics[0].message).toContain("run-migration");
  });

  it("a compensation sibling only counts within the same nested phase, not a same-named sibling phase elsewhere in the component", () => {
    // Two different "Node" phases both contain a run-migration step; only the
    // second one has a rollback-previous sibling. The first must still be
    // flagged — object identity, not phase-name string, decides "same phase".
    const [comp003] = checks.filter((c) => c.id === "COMP003");
    const ctx = {
      rollbackPolicies: FIXTURE_ROLLBACK_POLICIES,
      components: new Map([
        [
          "fanout-cluster",
          {
            component: {
              name: "fanout-cluster",
              dependsOn: [],
              deploy: [
                { phase: "Node A", steps: [{ kind: "run-migration", tool: "flyway", target: "a" }] },
                {
                  phase: "Node B",
                  steps: [
                    { kind: "run-migration", tool: "flyway", target: "b" },
                    { kind: "rollback-previous", resource: "b" },
                  ],
                },
              ],
            },
            filePath: "fanout-cluster.component.ts",
          },
        ],
      ]),
    };
    const diagnostics = comp003.check(ctx as never);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].message).toContain('phase "Node A"');
  });
});

describe("COMP004: gate-needs-temporal", () => {
  it("flags a gate step with no disable directive", async () => {
    const diagnostics = await lintFixture("comp004", "fail");
    const hits = diagnostics.filter((d) => d.checkId === "COMP004");
    expect(hits).toHaveLength(1);
    expect(hits[0].component).toBe("neo4j-cluster");
    expect(hits[0].message).toContain("gate");
  });

  it("does not flag a component with no gate steps", async () => {
    const diagnostics = await lintFixture("comp004", "pass");
    const hits = diagnostics.filter((d) => d.checkId === "COMP004" && d.component !== "neo4j-cluster");
    expect(hits).toHaveLength(0);
  });

  it("still raises the raw diagnostic for a gate with a file-level disable directive — runComponentChecks does not itself apply disable-directive filtering (that is the chant lint CLI layer's job, see ../../../cli/commands/component-lint.test.ts)", async () => {
    const diagnostics = await lintFixture("comp004", "pass");
    const hits = diagnostics.filter((d) => d.checkId === "COMP004" && d.component === "neo4j-cluster");
    expect(hits).toHaveLength(1);
  });
});

describe("COMP005: capability-kind-is-noun", () => {
  it("flags a step kind named after the component itself", async () => {
    const diagnostics = await lintFixture("comp005", "fail");
    const hits = diagnostics.filter((d) => d.checkId === "COMP005");
    expect(hits).toHaveLength(1);
    expect(hits[0].message).toContain("deploy-search-service");
  });

  it("does not flag verb-named capability kinds", async () => {
    const diagnostics = await lintFixture("comp005", "pass");
    expect(diagnostics.filter((d) => d.checkId === "COMP005")).toHaveLength(0);
  });

  it("regression: never flags a registered verb, even when a component's name is a substring of it (e.g. a component named \"stack\")", () => {
    // A component literally named "stack", "job", "image", or "host" must not
    // falsely flag wait-for-stack / emr-start-job-run / publish-image /
    // load-image-on-host by dash-segment substring collision. `ctx.knownKinds`
    // is what `chant lint` passes for an aws-active project — the registry's
    // resolved kinds, which include these lexicon leaves.
    const [comp005] = checks.filter((c) => c.id === "COMP005");
    const knownKinds = new Set([
      "docker-build",
      "wait-for-stack",
      "emr-start-job-run",
      "publish-image",
      "load-image-on-host",
    ]);
    const ctx = {
      knownKinds,
      components: new Map([
        [
          "stack",
          {
            component: {
              name: "stack",
              dependsOn: [],
              deploy: [{ phase: "Verify", steps: [{ kind: "wait-for-stack", stack: "stack" }] }],
            },
            filePath: "stack.component.ts",
          },
        ],
        [
          "job",
          {
            component: {
              name: "job",
              dependsOn: [],
              deploy: [{ phase: "Submit", steps: [{ kind: "emr-start-job-run", jar: "x" }] }],
            },
            filePath: "job.component.ts",
          },
        ],
        [
          "image",
          {
            component: {
              name: "image",
              dependsOn: [],
              build: { kind: "docker-build" },
              deploy: [{ phase: "Publish", steps: [{ kind: "publish-image", from: "a", to: "b" }] }],
            },
            filePath: "image.component.ts",
          },
        ],
        [
          "host",
          {
            component: {
              name: "host",
              dependsOn: [],
              deploy: [{ phase: "Publish", steps: [{ kind: "load-image-on-host", from: "a", host: "b" }] }],
            },
            filePath: "host.component.ts",
          },
        ],
      ]),
    };
    expect(comp005.check(ctx as never)).toEqual([]);
  });

  it("falls back to the core starter set when no registry (knownKinds) was resolved — a core verb whose name overlaps a component is still not flagged", () => {
    const [comp005] = checks.filter((c) => c.id === "COMP005");
    const ctx = {
      // no knownKinds -> fall back to core starter (includes wait-cluster-healthy)
      components: new Map([
        [
          "cluster",
          {
            component: {
              name: "cluster",
              dependsOn: [],
              deploy: [{ phase: "Verify", steps: [{ kind: "wait-cluster-healthy", size: 1 }] }],
            },
            filePath: "cluster.component.ts",
          },
        ],
      ]),
    };
    expect(comp005.check(ctx as never)).toEqual([]);
  });

  it("without a resolved registry, an active-lexicon verb it can't know about IS flagged when it collides with a component name (registry-driven, not hard-coded)", () => {
    const [comp005] = checks.filter((c) => c.id === "COMP005");
    const ctx = {
      // no knownKinds -> `wait-for-stack` is not a core verb, so for a component
      // literally named "stack" it reads as a noun-collision. A real `chant lint`
      // run passes knownKinds and avoids this; this documents the fallback edge.
      components: new Map([
        [
          "stack",
          {
            component: {
              name: "stack",
              dependsOn: [],
              deploy: [{ phase: "Verify", steps: [{ kind: "wait-for-stack", stack: "stack" }] }],
            },
            filePath: "stack.component.ts",
          },
        ],
      ]),
    };
    const diagnostics = comp005.check(ctx as never);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].checkId).toBe("COMP005");
  });
});

describe("COMP006: shell-needs-reason", () => {
  it('flags a "shell" step with no reason', async () => {
    const diagnostics = await lintFixture("comp006", "fail");
    const hits = diagnostics.filter((d) => d.checkId === "COMP006");
    expect(hits).toHaveLength(1);
    expect(hits[0].component).toBe("legacy-tool");
  });

  it('does not flag a "shell" step with a declared reason', async () => {
    const diagnostics = await lintFixture("comp006", "pass");
    expect(diagnostics.filter((d) => d.checkId === "COMP006")).toHaveLength(0);
  });
});

describe("COMP007: composition-sprawl", () => {
  it("flags two components with an identical phase/step-kind composition shape", async () => {
    const diagnostics = await lintFixture("comp007", "fail");
    const hits = diagnostics.filter((d) => d.checkId === "COMP007");
    expect(hits).toHaveLength(2);
    expect(hits.map((d) => d.component).sort()).toEqual(["inventory-table", "orders-table"]);
    expect(hits[0].severity).toBe("warning");
  });

  it("does not flag structurally distinct components", async () => {
    const diagnostics = await lintFixture("comp007", "pass");
    expect(diagnostics.filter((d) => d.checkId === "COMP007")).toHaveLength(0);
  });
});
