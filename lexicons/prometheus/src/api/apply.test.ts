/** The ruler apply target against a fake ruler (#3372). */

import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { dump } from "js-yaml";
import { planRuler, rulerApply, rulerRollback, toApplyResult } from "./apply";
import { fakeAlertmanager, fakeHttp, fakeRuler, serveFake, type FakeAlertmanagerState, type FakeRulerState } from "./fake-servers";
import type { RawRuleGroup } from "./ruler";

const group = (name: string, expr = "up == 0"): RawRuleGroup => ({ name, rules: [{ alert: `${name}Down`, expr, for: "5m" }] });

function build(groups: RawRuleGroup[], alertmanager?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-ruler-"));
  const path = join(dir, "rules.yml");
  writeFileSync(path, dump({ groups }));
  if (alertmanager !== undefined) writeFileSync(join(dir, "alertmanager.yml"), alertmanager);
  return path;
}

function setup(
  rulerState: FakeRulerState,
  opts: { namespace?: string; groupNamespaces?: Record<string, string>; am?: FakeAlertmanagerState } = {},
) {
  const rulerCalls: string[] = [];
  const amCalls: string[] = [];
  const kind = rulerState.kind as "mimir" | "cortex" | "loki";
  const deps = {
    config: {
      prometheus: {
        profiles: {
          prod: {
            ruler: { kind, url: "http://ruler.test", tenant: rulerState.tenant, namespace: opts.namespace ?? "shop", ...(opts.groupNamespaces ? { groupNamespaces: opts.groupNamespaces } : {}) },
            ...(opts.am ? { alertmanager: { kind: opts.am.kind as "mimir", url: "http://am.test", tenant: opts.am.tenant } } : {}),
          },
        },
      },
    },
    environment: "prod",
    http: {
      ruler: fakeHttp(fakeRuler(rulerState, rulerCalls), rulerState.tenant ? { "x-scope-orgid": rulerState.tenant } : {}),
      ...(opts.am ? { alertmanager: fakeHttp(fakeAlertmanager(opts.am, amCalls), opts.am.tenant ? { "x-scope-orgid": opts.am.tenant } : {}) } : {}),
    },
  };
  return { deps, rulerCalls, amCalls };
}

describe("rulerApply plan and apply", () => {
  test("plan diffs declared groups against the ruler's, per declared namespace", async () => {
    const state: FakeRulerState = { kind: "mimir", namespaces: { shop: [group("a"), group("b", "up == 1")] } };
    const { deps } = setup(state);
    const entries = await planRuler({ buildPath: build([group("a"), group("b"), group("c")]), environment: "prod", prune: true }, deps);
    expect(entries.map((e) => `${e.action} ${e.name}`).sort()).toEqual(["create shop/c", "unchanged shop/a", "update shop/b"]);
  });

  test("apply posts created and changed groups and leaves an unchanged one alone", async () => {
    const state: FakeRulerState = { kind: "mimir", namespaces: { shop: [group("a"), group("b", "up == 1")] } };
    const { deps, rulerCalls } = setup(state);
    const outcome = await rulerApply({ buildPath: build([group("a"), group("b"), group("c")]), environment: "prod" }, deps);
    expect(outcome.applied.map((a) => `${a.action} ${a.name}`).sort()).toEqual(["created shop/c", "unchanged shop/a", "updated shop/b"]);
    expect(rulerCalls.filter((c) => c.startsWith("POST"))).toEqual([
      "POST /prometheus/config/v1/rules/shop",
      "POST /prometheus/config/v1/rules/shop",
    ]);
    expect(state.namespaces.shop.map((g) => g.name).sort()).toEqual(["a", "b", "c"]);
    expect(toApplyResult(outcome).applied).toHaveLength(3);
  });

  test("a group the ruler decorates with fields of its own is unchanged", async () => {
    const state: FakeRulerState = { kind: "mimir", namespaces: { shop: [{ ...group("a"), source_tenants: ["shop"] }] } };
    const { deps, rulerCalls } = setup(state);
    const outcome = await rulerApply({ buildPath: build([group("a")]), environment: "prod" }, deps);
    expect(outcome.applied).toEqual([{ kind: "RuleGroup", name: "shop/a", action: "unchanged" }]);
    expect(rulerCalls.some((c) => c.startsWith("POST"))).toBe(false);
  });
});

describe("owned-only delete", () => {
  test("removes undeclared groups in a declared namespace and never touches a namespace the project does not declare", async () => {
    const other = [group("theirs"), group("theirs-too")];
    const state: FakeRulerState = {
      kind: "mimir",
      namespaces: { shop: [group("a"), group("stale")], "platform-team": other, "moved-away": [group("a")] },
    };
    const { deps, rulerCalls } = setup(state);
    const outcome = await rulerApply({ buildPath: build([group("a")]), environment: "prod", prune: true }, deps);

    expect(outcome.pruned).toEqual([{ kind: "RuleGroup", name: "shop/stale", deleted: true }]);
    expect(state.namespaces.shop.map((g) => g.name)).toEqual(["a"]);
    // The namespaces the project does not declare are intact, and no request ever named them.
    expect(state.namespaces["platform-team"]).toEqual(other);
    expect(state.namespaces["moved-away"]).toEqual([group("a")]);
    expect(rulerCalls.filter((c) => c.includes("platform-team") || c.includes("moved-away"))).toEqual([]);
    // Nor was the whole tenant listed: that is how a sync would find namespaces to delete.
    expect(rulerCalls).not.toContain("GET /prometheus/config/v1/rules");
    expect(rulerCalls.filter((c) => c.startsWith("DELETE"))).toEqual(["DELETE /prometheus/config/v1/rules/shop/stale"]);
  });

  test("without prune nothing is deleted", async () => {
    const state: FakeRulerState = { kind: "mimir", namespaces: { shop: [group("a"), group("stale")] } };
    const { deps, rulerCalls } = setup(state);
    await rulerApply({ buildPath: build([group("a")]), environment: "prod" }, deps);
    expect(rulerCalls.some((c) => c.startsWith("DELETE"))).toBe(false);
    expect(state.namespaces.shop).toHaveLength(2);
  });

  test("a group routed by groupNamespaces lands in its own namespace, and both are owned", async () => {
    const state: FakeRulerState = { kind: "mimir", namespaces: { shop: [group("stale")], infra: [group("old")], elsewhere: [group("x")] } };
    const { deps } = setup(state, { groupNamespaces: { disk: "infra" } });
    await rulerApply({ buildPath: build([group("a"), group("disk")]), environment: "prod", prune: true }, deps);
    expect(state.namespaces.shop.map((g) => g.name)).toEqual(["a"]);
    expect(state.namespaces.infra.map((g) => g.name)).toEqual(["disk"]);
    expect(state.namespaces.elsewhere).toEqual([group("x")]);
  });
});

describe("tenants and path variants", () => {
  test("X-Scope-OrgID is the environment's tenant, over a real HTTP server", async () => {
    const state: FakeRulerState = { kind: "mimir", tenant: "shop", namespaces: {} };
    const server = await serveFake(fakeRuler(state));
    try {
      const deps = {
        config: { prometheus: { profiles: { prod: { ruler: { kind: "mimir" as const, url: server.url, tenant: "shop", namespace: "shop" } } } } },
        environment: "prod",
      };
      const outcome = await rulerApply({ buildPath: build([group("a")]), environment: "prod" }, deps);
      expect(outcome.applied).toEqual([{ kind: "RuleGroup", name: "shop/a", action: "created" }]);
      expect(state.namespaces.shop).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  test("a wrong tenant is refused, and reported rather than thrown", async () => {
    const state: FakeRulerState = { kind: "mimir", tenant: "other", namespaces: {} };
    const { deps } = setup({ ...state, tenant: "other" });
    const refused = { ...deps, http: { ruler: fakeHttp(fakeRuler(state), { "x-scope-orgid": "wrong" }) } };
    const outcome = await rulerApply({ buildPath: build([group("a")]), environment: "prod" }, refused);
    expect(outcome.applied).toEqual([]);
    expect(outcome.notAttempted[0].reason).toBe("no-credentials");
  });

  test.each([
    ["cortex", "/api/v1/rules/shop"],
    ["loki", "/loki/api/v1/rules/shop"],
    ["mimir", "/prometheus/config/v1/rules/shop"],
  ] as const)("%s posts to %s", async (kind, path) => {
    const state: FakeRulerState = { kind, namespaces: {} };
    const { deps, rulerCalls } = setup(state);
    await rulerApply({ buildPath: build([group("a")]), environment: "prod" }, deps);
    expect(rulerCalls).toContain(`POST ${path}`);
  });
});

describe("Alertmanager config upload", () => {
  const amYaml = "route:\n  receiver: default\nreceivers:\n  - name: default\n";

  test("uploads the config beside the rule file under the same target", async () => {
    const am: FakeAlertmanagerState = { kind: "mimir", tenant: "shop" };
    const { deps } = setup({ kind: "mimir", tenant: "shop", namespaces: {} }, { am });
    const outcome = await rulerApply({ buildPath: build([group("a")], amYaml), environment: "prod" }, deps);
    expect(outcome.applied.map((a) => `${a.action} ${a.kind}`).sort()).toEqual(["created AlertmanagerConfig", "created RuleGroup"]);
    expect(am.uploaded?.alertmanager_config).toBe(amYaml);
  });

  test("an unchanged config is not uploaded again", async () => {
    const am: FakeAlertmanagerState = { kind: "mimir", uploaded: { alertmanager_config: amYaml } };
    const { deps, amCalls } = setup({ kind: "mimir", namespaces: {} }, { am });
    const outcome = await rulerApply({ buildPath: build([group("a")], amYaml), environment: "prod" }, deps);
    expect(outcome.applied.find((a) => a.kind === "AlertmanagerConfig")?.action).toBe("unchanged");
    expect(amCalls.some((c) => c.startsWith("POST"))).toBe(false);
  });

  test("a plain Alertmanager has no upload API and is reported not attempted", async () => {
    const am: FakeAlertmanagerState = { kind: "alertmanager", original: amYaml };
    const { deps } = setup({ kind: "mimir", namespaces: {} }, { am });
    const outcome = await rulerApply({ buildPath: build([group("a")], amYaml), environment: "prod" }, deps);
    expect(outcome.notAttempted).toMatchObject([{ kind: "AlertmanagerConfig", reason: "unsupported-kind" }]);
  });
});

describe("rollback re-applies the previous group set", () => {
  test("restores replaced and pruned groups, removes created ones, and leaves other namespaces alone", async () => {
    const other = [group("theirs")];
    const state: FakeRulerState = { kind: "mimir", namespaces: { shop: [group("b", "up == 1"), group("stale")], other } };
    const { deps, rulerCalls } = setup(state);
    const path = build([group("b"), group("c")]);
    await rulerApply({ buildPath: path, environment: "prod", prune: true }, deps);
    expect(state.namespaces.shop.map((g) => g.name).sort()).toEqual(["b", "c"]);

    const outcome = await rulerRollback({ buildPath: path, environment: "prod" }, deps);
    expect(outcome).toMatchObject({ restored: 2, removed: 1, hadSnapshot: true });
    expect(state.namespaces.shop.map((g) => g.name).sort()).toEqual(["b", "stale"]);
    expect(state.namespaces.shop.find((g) => g.name === "b")).toMatchObject({ rules: [{ expr: "up == 1" }] });
    expect(state.namespaces.other).toEqual(other);
    expect(rulerCalls.filter((c) => c.includes("/other"))).toEqual([]);
  });

  test("restores the previous Alertmanager config", async () => {
    const before = "route:\n  receiver: old\nreceivers:\n  - name: old\n";
    const am: FakeAlertmanagerState = { kind: "mimir", uploaded: { alertmanager_config: before } };
    const { deps } = setup({ kind: "mimir", namespaces: {} }, { am });
    const path = build([group("a")], "route:\n  receiver: new\nreceivers:\n  - name: new\n");
    await rulerApply({ buildPath: path, environment: "prod" }, deps);
    expect(am.uploaded?.alertmanager_config).toContain("new");
    const outcome = await rulerRollback({ buildPath: path, environment: "prod" }, deps);
    expect(outcome.alertmanagerRestored).toBe(true);
    expect(am.uploaded?.alertmanager_config).toBe(before);
  });

  test("with no snapshot there is nothing to restore", async () => {
    const { deps } = setup({ kind: "mimir", namespaces: {} });
    const path = build([group("a")]);
    expect((await rulerRollback({ buildPath: path, environment: "prod" }, deps)).hadSnapshot).toBe(false);
    expect(existsSync(path)).toBe(true);
  });
});
