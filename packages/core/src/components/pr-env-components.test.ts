/**
 * #4762: a pull request's environment of separately planned components,
 * through prEnvUp and prEnvDown with in-memory ports and a component planner
 * that records what it was asked. No engine, ledger or forge is reached.
 */
import { describe, expect, test } from "vitest";
import { NEXT_RELEASE } from "../release-floors";
import { componentsPrEnvAdapter, componentsPrEnvTeardown, PR_ENV_COMPONENTS_FLOOR, type PrEnvComponentPlan } from "./pr-env-components";
import { prEnvDown, prEnvUp, type PrEnvApproval, type PrEnvPorts } from "./pr-env-run";
import { livePrEnvironments, type PrEnvRecord } from "./pr-environment";

const HEAD = "b".repeat(40);
const NOW = () => new Date("2026-11-08T10:00:00.000Z");

function ports(approval: PrEnvApproval, records: PrEnvRecord[] = []): PrEnvPorts & { records: PrEnvRecord[]; digests: string[] } {
  const digests: string[] = [];
  return {
    records,
    digests,
    readRecords: async () => [...records],
    appendRecord: async (r) => void records.push(r),
    decideGate: async (input) => {
      digests.push(input.digest);
      return approval;
    },
  };
}

/** A planner over named components: each plans `changes` creates at `<name>-<env>`, unless told to fail. */
function planner(opts: { changes?: number; failPlan?: string; failApply?: string } = {}) {
  const applied: string[] = [];
  const planned: string[] = [];
  const plan = (name: string, env: string, destroy = false): PrEnvComponentPlan => {
    planned.push(`${destroy ? "destroy " : ""}${name}`);
    if (name === opts.failPlan) return { component: name, planDigest: "", create: 0, update: 0, replace: 0, delete: 0, error: "plan failed", apply: async () => {} };
    return {
      component: name,
      planDigest: `sha256:${name}${destroy ? "-destroy" : ""}`,
      create: destroy ? 0 : (opts.changes ?? 1),
      update: 0,
      replace: 0,
      delete: destroy ? 1 : 0,
      location: `s3://acme/${name}-${env}.tfstate`,
      apply: async () => {
        if (name === opts.failApply) throw new Error("apply broke");
        applied.push(`${destroy ? "destroy " : ""}${name}`);
      },
    };
  };
  return { applied, planned, plan };
}

const up = (p: PrEnvPorts, adapter: ReturnType<typeof componentsPrEnvAdapter>) => prEnvUp({ pr: 7, head: HEAD, template: "copy", stack: "product", adapter, ports: p, now: NOW });

describe("componentsPrEnvAdapter", () => {
  test("plans every component, waits for an approval of the set digest, then applies in order and records where each copy is", async () => {
    const pl = planner();
    const adapter = componentsPrEnvAdapter({ components: async () => ["network", "app"], plan: (n, _i, t) => Promise.resolve(pl.plan(n, t.env)) });
    const waiting = ports({ status: "pending" });
    const first = await up(waiting, adapter);
    expect(first.exit).toBe(3);
    expect(pl.applied).toEqual([]);
    const p = ports({ status: "approved", approvedBy: ["bo"] });
    const second = await up(p, adapter);
    expect(second.exit).toBe(0);
    expect(p.digests).toEqual(waiting.digests);
    expect(pl.applied).toEqual(["network", "app"]);
    expect(p.records[0]).toMatchObject({ components: ["network", "app"], locations: { network: "s3://acme/network-pr-7.tfstate", app: "s3://acme/app-pr-7.tfstate" }, result: "applied" });
  });

  test("an empty plan applies with no approval, and no components gives the environment nothing", async () => {
    const pl = planner({ changes: 0 });
    const p = ports({ status: "pending" });
    expect((await up(p, componentsPrEnvAdapter({ components: async () => ["app"], plan: (n, _i, t) => Promise.resolve(pl.plan(n, t.env)) }))).exit).toBe(0);
    expect(p.digests).toEqual([]);
    expect(pl.applied).toEqual(["app"]);
    const none = await up(ports({ status: "pending" }), componentsPrEnvAdapter({ components: async () => [], plan: async () => pl.plan("x", "pr-7"), nothing: () => "no root matches" }));
    expect(none.report).toMatchObject({ status: "nothing", message: "no root matches" });
  });

  test("a component that does not plan stops the environment, and one that does not apply stops the rest", async () => {
    const pl = planner({ failPlan: "app" });
    const failedPlan = await up(ports({ status: "approved" }), componentsPrEnvAdapter({ components: async () => ["network", "app"], plan: (n, _i, t) => Promise.resolve(pl.plan(n, t.env)) }));
    expect(failedPlan.report.status).toBe("plan-failed");
    expect(pl.applied).toEqual([]);
    const pa = planner({ failApply: "network" });
    const p = ports({ status: "approved" });
    const failedApply = await up(p, componentsPrEnvAdapter({ components: async () => ["network", "app"], plan: (n, _i, t) => Promise.resolve(pa.plan(n, t.env)) }));
    expect(failedApply.exit).toBe(1);
    expect(failedApply.report.components.map((c) => c.status)).toEqual(["failed", "not applied"]);
    expect(p.records[0]!.result).toBe("failed");
  });

  test("a refusal thrown while planning is kept for the caller", async () => {
    const adapter = componentsPrEnvAdapter({ components: async () => ["app"], plan: async () => Promise.reject(new Error("a cloud block")) });
    const r = await up(ports({ status: "approved" }), adapter);
    expect(r.report.status).toBe("plan-failed");
    expect(adapter.refused?.message).toBe("a cloud block");
  });
});

describe("componentsPrEnvTeardown", () => {
  test("destroys the components it owns in reverse apply order, and leaves a hole for a location that is not the environment's", async () => {
    const pl = planner();
    const p = ports({ status: "approved" });
    await up(p, componentsPrEnvAdapter({ components: async () => ["network", "app", "dns"], plan: (n, _i, t) => Promise.resolve(pl.plan(n, t.env)) }));
    const rec = p.records[0]!;
    rec.locations!.dns = "s3://acme/dns.tfstate";
    let released = 0;
    const teardown = componentsPrEnvTeardown({
      name: "product",
      type: "terraform_root",
      owns: (location, env) => location.endsWith(`-${env}.tfstate`),
      checkout: async () => ({ plan: async (n) => pl.plan(n, "pr-7", true), done: () => void released++ }),
    });
    const down = await prEnvDown({ pr: 7, reason: "closed", ports: p, adapters: [teardown], commit: HEAD, now: NOW });
    expect(pl.applied.filter((a) => a.startsWith("destroy"))).toEqual(["destroy app", "destroy network"]);
    expect(released).toBe(1);
    expect(down.report.status).toBe("incomplete");
    expect(livePrEnvironments(p.records).get("pr-7")?.teardownIncomplete).toBe(true);
  });

  test("a destroy that fails is that component's failure alone", async () => {
    const pl = planner({ failApply: "app" });
    const p = ports({ status: "approved" });
    await up(p, componentsPrEnvAdapter({ components: async () => ["network"], plan: (n, _i, t) => Promise.resolve(pl.plan(n, t.env)) }));
    p.records[0]!.components.push("app");
    p.records[0]!.locations!.app = "s3://acme/app-pr-7.tfstate";
    const teardown = componentsPrEnvTeardown({ name: "product", type: "terraform_root", owns: () => true, checkout: async () => ({ plan: async (n) => pl.plan(n, "pr-7", true) }) });
    const down = await prEnvDown({ pr: 7, reason: "closed", ports: p, adapters: [teardown], commit: HEAD, now: NOW });
    expect(pl.applied).toContain("destroy network");
    expect(down.report.status).toBe("incomplete");
  });

  test("its floor is the next release", () => {
    expect(PR_ENV_COMPONENTS_FLOOR).toBe(NEXT_RELEASE);
  });
});
