/**
 * A pull request's environment (#4298): what it derives from the template,
 * the records that say which environments stand, and the ownership check a
 * teardown runs before it deletes anything.
 */

import { describe, expect, test } from "vitest";
import type { ChantConfig } from "../config";
import type { TeardownPlan, TeardownReport } from "../lifecycle/teardown";
import type { ObservationLexicon, TeardownCandidate } from "../lexicon";
import {
  derivePrEnvironment,
  expired,
  isPrEnvironmentName,
  livePrEnvironments,
  ownedEntries,
  parsePrEnvRecords,
  prEnvStatusState,
  releaseTargetRefusal,
  renderPrEnvNote,
  teardownComplete,
  tearDownPrEnvironment,
  teardownRefusal,
  ttlMs,
  type PrEnvRecord,
} from "./pr-environment";

const CONFIG: ChantConfig = {
  environments: ["local", { name: "staging", endpoint: "http://localhost:4566" }, "prod", "pr-*"],
  ownership: { stack: "shop", env: { param: "env" } },
  buildParams: { env: { type: "string", default: "local" } },
} as ChantConfig;

function up(over: Partial<PrEnvRecord> = {}): PrEnvRecord {
  return {
    version: 1,
    kind: "up",
    pr: 7,
    env: "pr-7",
    template: "staging",
    marker: { stack: "shop", env: "pr-7" },
    commit: "a".repeat(40),
    components: ["app"],
    planDigest: "sha256:aa",
    result: "applied",
    by: "octo",
    timestamp: "2026-10-22T10:00:00.000Z",
    expiresAt: "2026-10-25T10:00:00.000Z",
    releaseTarget: false,
    ...over,
  };
}

describe("deriving a pull request's environment", () => {
  test("pr-<n> takes the template's endpoint and the marker env follows the build parameter", () => {
    const d = derivePrEnvironment(CONFIG, "staging", 7);
    expect(d).toMatchObject({ env: "pr-7", template: "staging", stack: "shop", param: "env", endpoint: "http://localhost:4566" });
    if ("refusal" in d) throw new Error(d.refusal);
    expect(d.environments?.[0]).toEqual({ name: "pr-7", endpoint: "http://localhost:4566" });
  });

  test("a pr-* entry's own endpoint wins over the template's", () => {
    const config = { ...CONFIG, environments: ["staging", { name: "pr-*", endpoint: "http://localhost:9000" }] } as ChantConfig;
    expect(derivePrEnvironment(config, "staging", 7)).toMatchObject({ endpoint: "http://localhost:9000" });
  });

  test("refuses when the resources could not be told apart from the template's", () => {
    const off = derivePrEnvironment({ ...CONFIG, ownership: undefined } as ChantConfig, "staging", 7);
    expect(off).toMatchObject({ refusal: expect.stringContaining("no ownership.stack") });
    const literal = derivePrEnvironment({ ...CONFIG, ownership: { stack: "shop", env: "staging" } } as ChantConfig, "staging", 7);
    expect(literal).toMatchObject({ refusal: expect.stringContaining('the literal "staging"') });
    const unset = derivePrEnvironment({ ...CONFIG, ownership: { stack: "shop" } } as ChantConfig, "staging", 7);
    expect(unset).toMatchObject({ refusal: expect.stringContaining("ownership.env is unset") });
  });

  test("refuses a template the config does not declare, and a name it would not take", () => {
    expect(derivePrEnvironment(CONFIG, "qa", 7)).toMatchObject({ refusal: expect.stringContaining("do not declare") });
    const noPattern = { ...CONFIG, environments: ["staging", "prod"] } as ChantConfig;
    expect(derivePrEnvironment(noPattern, "staging", 7)).toMatchObject({ refusal: expect.stringContaining('add "pr-*"') });
    const literal = { ...CONFIG, environments: ["staging", "pr-7", "pr-*"] } as ChantConfig;
    expect(derivePrEnvironment(literal, "staging", 7)).toMatchObject({ refusal: expect.stringContaining("declared outright") });
  });
});

describe("the records", () => {
  test("an up makes an environment live, a destroying down ends it, an incomplete down leaves it", () => {
    const records = [up(), up({ pr: 8, env: "pr-8", marker: { stack: "shop", env: "pr-8" } }), { ...up(), kind: "down" as const, result: "destroyed" as const }];
    const live = livePrEnvironments(records);
    expect([...live.keys()]).toEqual(["pr-8"]);
    const incomplete = livePrEnvironments([up(), { ...up(), kind: "down", result: "incomplete" }]);
    expect(incomplete.get("pr-7")?.teardownIncomplete).toBe(true);
  });

  test("a later up refreshes the expiry and keeps every component it ever applied", () => {
    const live = livePrEnvironments([up(), up({ components: ["db"], expiresAt: "2026-10-26T10:00:00.000Z" })]).get("pr-7")!;
    expect(live.components).toEqual(["app", "db"]);
    expect(live.expiresAt).toBe("2026-10-26T10:00:00.000Z");
    expect(expired(live, new Date("2026-10-26T10:00:00.000Z"))).toBe(true);
    expect(expired(live, new Date("2026-10-25T10:00:00.000Z"))).toBe(false);
  });

  test("malformed lines are skipped", () => {
    expect(parsePrEnvRecords(`not json\n${JSON.stringify(up())}\n{"version":2}\n`)).toHaveLength(1);
  });
});

describe("the ownership check on teardown", () => {
  const live = livePrEnvironments([up()]).get("pr-7")!;

  test("passes for the pull request's own environment", () => {
    expect(teardownRefusal(7, live, CONFIG.environments)).toBeUndefined();
  });

  test("refuses another pull request's record, a marker of another environment, and a declared environment", () => {
    expect(teardownRefusal(8, live, CONFIG.environments)).toContain("not 8");
    expect(teardownRefusal(7, { ...live, marker: { stack: "shop", env: "staging" } }, CONFIG.environments)).toContain("another environment's resources");
    expect(teardownRefusal(7, live, ["staging", "pr-7"])).toContain("declared outright");
  });

  test("drops every planned entry whose marker is not exactly the environment's", () => {
    const plan: TeardownPlan = {
      environment: "pr-7",
      stack: "shop",
      entries: [
        { lexicon: "k8s", name: "web", type: "K8s::Apps::Deployment", marker: { stack: "shop", env: "pr-7" } },
        { lexicon: "k8s", name: "web", type: "K8s::Apps::Deployment", marker: { stack: "shop", env: "staging" } },
        { lexicon: "k8s", name: "other", type: "K8s::Core::Service", marker: { stack: "other", env: "pr-7" } },
      ],
      holes: [],
      skipped: [],
    };
    const owned = ownedEntries(plan, { stack: "shop", env: "pr-7" });
    expect(owned.plan.entries.map((e) => e.marker)).toEqual([{ stack: "shop", env: "pr-7" }]);
    expect(owned.dropped).toHaveLength(2);
  });

  test("a teardown with a failure, a skip or a hole is not complete", () => {
    const plan: TeardownPlan = { environment: "pr-7", stack: "shop", entries: [], holes: [], skipped: [] };
    const report = (outcome: TeardownReport["outcomes"][number]["outcome"]): TeardownReport => ({
      environment: "pr-7",
      stack: "shop",
      plan,
      outcomes: [{ lexicon: "k8s", name: "web", type: "K8s::Apps::Deployment", marker: { stack: "shop", env: "pr-7" }, outcome }],
      unimplemented: [],
    });
    expect(teardownComplete(report("deleted"))).toBe(true);
    expect(teardownComplete(report("retained"))).toBe(true);
    expect(teardownComplete(report("failed"))).toBe(false);
    expect(teardownComplete(report("skipped"))).toBe(false);
    expect(teardownComplete({ ...report("deleted"), plan: { ...plan, holes: [{ lexicon: "k8s", name: "*", reason: "read-failed" }] } })).toBe(false);
  });
});

describe("tearing down through the lexicons", () => {
  const live = livePrEnvironments([up()]).get("pr-7")!;

  /** A lexicon whose enumeration also returns another environment's resource, and records what it was asked to delete. */
  function lexicon(): { plugin: ObservationLexicon; asked: { environment?: string; deleted: TeardownCandidate[] } } {
    const asked: { environment?: string; deleted: TeardownCandidate[] } = { deleted: [] };
    const plugin = {
      name: "k8s",
      async teardownOwned({ environment }: { environment: string }) {
        asked.environment = environment;
        return {
          candidates: [
            { name: "web", type: "K8s::Apps::Deployment", marker: { stack: "shop", env: "pr-7" } },
            { name: "web", type: "K8s::Apps::Deployment", marker: { stack: "shop", env: "staging" } },
          ],
        };
      },
      async executeTeardown({ candidates }: { candidates: TeardownCandidate[] }) {
        asked.deleted.push(...candidates);
        return { outcomes: candidates.map((c) => ({ name: c.name, outcome: "deleted" as const })) };
      },
    } as unknown as ObservationLexicon;
    return { plugin, asked };
  }

  test("deletes only what carries pr-<n>'s marker", async () => {
    const { plugin, asked } = lexicon();
    const torn = await tearDownPrEnvironment({ pr: 7, live, config: CONFIG, plugins: [plugin] });
    if ("refusal" in torn) throw new Error(torn.refusal);
    expect(asked.environment).toBe("pr-7");
    expect(asked.deleted.map((c) => c.marker)).toEqual([{ stack: "shop", env: "pr-7" }]);
    expect(teardownComplete(torn.report)).toBe(true);
  });

  test("a refused teardown reads and deletes nothing", async () => {
    const { plugin, asked } = lexicon();
    const torn = await tearDownPrEnvironment({ pr: 7, live: { ...live, marker: { stack: "shop", env: "staging" } }, config: CONFIG, plugins: [plugin] });
    expect(torn).toMatchObject({ refusal: expect.stringContaining("nothing was torn down") });
    expect(asked.environment).toBeUndefined();
    expect(asked.deleted).toEqual([]);
  });
});

describe("not a release target", () => {
  test("a pr-<n> name is refused as a release's source or target, and nothing else is", () => {
    expect(isPrEnvironmentName("pr-42")).toBe(true);
    expect(isPrEnvironmentName("pr-")).toBe(false);
    expect(isPrEnvironmentName("prod")).toBe(false);
    expect(releaseTargetRefusal("pr-42")).toContain("never a release target");
    expect(releaseTargetRefusal("staging")).toBeUndefined();
  });

  test("the note says so", () => {
    const note = renderPrEnvNote({ stage: "up", pr: 7, env: "pr-7", template: "staging", head: "a".repeat(40), op: "pr-7", gate: "pr-env", digest: "sha256:aa", status: "waiting", components: [] });
    expect(note).toContain("<!-- chant-pr-env:pr-7 -->");
    expect(note).toContain("chant approve pr-7 pr-env --plan sha256:aa");
    expect(note).toContain("is not a release target");
    expect(prEnvStatusState({ status: "waiting" })).toBe("pending");
  });
});

test("ttlMs reads minutes, hours and days", () => {
  expect(ttlMs("90m")).toBe(5_400_000);
  expect(ttlMs("72h")).toBe(259_200_000);
  expect(ttlMs("7d")).toBe(604_800_000);
  expect(ttlMs("1w")).toBeUndefined();
});
