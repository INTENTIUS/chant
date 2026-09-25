import { describe, test, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import type { DeployContext } from "@intentius/chant/components/capability";
import type { EffectReceiptRef, ReceiptStore } from "@intentius/chant/op/receipt-store";
import { buildChangeSet } from "@intentius/chant/lifecycle/change-set";
import { liveEvidenceFromChangeSet, reconcileStatus, type EntityLiveRead } from "@intentius/chant/lifecycle/status";
import type { ReleaseRecord } from "@intentius/chant/lifecycle/release-ledger";
import { normalizeObservation } from "@intentius/chant/observation";
import { createFlyReleaseCapability, createFlyRollbackCapability, migrationReceipt, type FlyReleaseDeps } from "./fly-release";
import { flyCapabilityPlugin } from "./capability-plugin";
import { createMachinesFake, type MachinesFake } from "../op/activities/machines-fake";
import { memoryMachineConfigStore } from "../release-store";
import { readMachineRelease } from "../release-metadata";
import { describeResources } from "../describe-resources";

const ENDPOINT = "http://flaps.test";
const NO_WAIT = { intervalMs: 0, deadlineMs: 2_000 };
const CTX: DeployContext = { env: "prod", component: "shop" };

const PLAN = {
  shop: { endpoint: "/v1/apps", method: "POST", body: { app_name: "shop", org_slug: "personal" } },
  web: {
    endpoint: "/v1/apps/shop/machines",
    method: "POST",
    body: { name: "web", config: { image: "shop:declared", metadata: { "managed-by": "chant" } } },
  },
};

function memoryReceipts(): ReceiptStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    read: async (r: EffectReceiptRef) => values.get(r.name),
    write: async (r: EffectReceiptRef, v: string) => void values.set(r.name, v),
  };
}

let dir: string;
let planPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fly-release-"));
  planPath = join(dir, "fly.json");
  writeFileSync(planPath, JSON.stringify(PLAN));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup(fake: MachinesFake = createMachinesFake()) {
  const configs = memoryMachineConfigStore();
  const receipts = memoryReceipts();
  const lines: string[] = [];
  const deps: FlyReleaseDeps = {
    http: fake.http,
    configStore: () => configs,
    receiptStore: () => receipts,
    headCommit: async () => "0000000000000000000000000000000000000000",
    log: (l) => lines.push(l),
  };
  return {
    fake,
    configs,
    receipts,
    lines,
    release: createFlyReleaseCapability(deps),
    rollback: createFlyRollbackCapability(deps),
  };
}

const input = (digest: string, extra: Record<string, unknown> = {}) => ({
  plan: planPath,
  digest,
  gitSha: `${digest.slice(7, 14)}`,
  endpoint: ENDPOINT,
  wait: NO_WAIT,
  verify: { intervalMs: 1, timeoutMs: 20 },
  ...extra,
});

describe("fly-release", () => {
  test("is registered by the fly capability plugin, with a native rollback", () => {
    const kinds = flyCapabilityPlugin.capabilities().map((c) => c.kind);
    expect(kinds).toEqual(expect.arrayContaining(["fly-release", "fly-rollback"]));
    const release = flyCapabilityPlugin.capabilities().find((c) => c.kind === "fly-release");
    expect(release?.rollbackPolicy).toBe("native");
  });

  test("serves the release, records it on the Machine, and returns what the ledger records", async () => {
    const s = setup();
    const out = await s.release.run(CTX, input("sha256:aaaaaaaaaaaa", { image: "shop@sha256:img" }));
    expect(out).toMatchObject({ uri: "fly://shop/web", digest: "sha256:aaaaaaaaaaaa", app: "shop", previous: null, migrations: [] });
    const m = s.fake.machine("shop", "web")!;
    expect(m.config.image).toBe("shop@sha256:img");
    expect(readMachineRelease(m.config.metadata)).toEqual({ digest: "sha256:aaaaaaaaaaaa", gitSha: "aaaaaaa" });
    // The config it applied is kept for a later rollback.
    expect(await s.configs.read({ app: "shop", machine: "web", digest: "sha256:aaaaaaaaaaaa" })).toEqual(m.config);
  });

  test("the commit defaults to HEAD, as the ledger records it", async () => {
    const s = setup();
    const out = await s.release.run(CTX, { ...input("sha256:aaaaaaaaaaaa"), gitSha: undefined });
    expect(out.gitSha).toBe("0000000000000000000000000000000000000000");
  });

  test("each migration fires once per environment, then the Machine restarts", async () => {
    const s = setup();
    const migrations = [
      { name: "001_init.sql", command: "node migrate.js 001_init.sql", sha: "sha256:m1" },
      { name: "002_add.sql", command: ["node", "migrate.js", "002_add.sql"] },
    ];
    const first = await s.release.run(CTX, input("sha256:aaaaaaaaaaaa", { migrations }));
    expect(first.migrations).toEqual([
      { name: "001_init.sql", fired: true },
      { name: "002_add.sql", fired: true },
    ]);
    expect(s.fake.execs.map((e) => e.command)).toEqual([
      ["sh", "-c", "node migrate.js 001_init.sql"],
      ["node", "migrate.js", "002_add.sql"],
    ]);
    expect(s.fake.calls.some((c) => c.endsWith("/restart"))).toBe(true);
    expect(s.receipts.values.get("fly-migration:shop/001_init.sql")).toBe("sha256:m1");

    const second = await s.release.run(CTX, input("sha256:bbbbbbbbbbbb", { migrations: [...migrations, { name: "003.sql", command: "m 3" }] }));
    expect(second.migrations).toEqual([
      { name: "001_init.sql", fired: false },
      { name: "002_add.sql", fired: false },
      { name: "003.sql", fired: true },
    ]);
    expect(s.fake.execs).toHaveLength(3);
  });

  test("a failed migration restores the previous release's config, leaves its receipt unwritten, and fails", async () => {
    const fake = createMachinesFake({ exec: (_a, _m, cmd) => (cmd.join(" ").includes("boom") ? { exit_code: 1, stderr: "boom" } : { exit_code: 0 }) });
    const s = setup(fake);
    await s.release.run(CTX, input("sha256:aaaaaaaaaaaa", { image: "shop:1" }));
    const before = structuredClone(fake.machine("shop", "web")!.config);
    await expect(
      s.release.run(CTX, input("sha256:bbbbbbbbbbbb", { image: "shop:2", migrations: [{ name: "004.sql", command: "boom" }] })),
    ).rejects.toThrow(/exited 1/);
    expect(fake.machine("shop", "web")!.config).toEqual(before);
    expect(s.receipts.values.has("fly-migration:shop/004.sql")).toBe(false);
    expect(await s.configs.read({ app: "shop", machine: "web", digest: "sha256:bbbbbbbbbbbb" })).toBeUndefined();
  });

  test("a failed first release stops the Machine: nothing was served before", async () => {
    const fake = createMachinesFake({ exec: () => ({ exit_code: 2 }) });
    const s = setup(fake);
    await expect(s.release.run(CTX, input("sha256:aaaaaaaaaaaa", { migrations: [{ name: "1", command: "x" }] }))).rejects.toThrow();
    expect(fake.machine("shop", "web")!.state).toBe("stopped");
  });

  test("its saga rollback puts back the previous release's Machine config", async () => {
    const s = setup();
    await s.release.run(CTX, input("sha256:aaaaaaaaaaaa", { image: "shop:1" }));
    const one = structuredClone(s.fake.machine("shop", "web")!.config);
    const i2 = input("sha256:bbbbbbbbbbbb", { image: "shop:2" });
    const out = await s.release.run(CTX, i2);
    expect(out.previous?.digest).toBe("sha256:aaaaaaaaaaaa");
    await s.release.rollback!(CTX, i2, out);
    expect(s.fake.machine("shop", "web")!.config).toEqual(one);
  });

  test("a Machine released before configs were kept can still be rolled back to", async () => {
    const s = setup();
    await s.release.run(CTX, input("sha256:aaaaaaaaaaaa", { image: "shop:1" }));
    s.configs.entries.clear();
    await s.release.run(CTX, input("sha256:bbbbbbbbbbbb", { image: "shop:2" }));
    expect(await s.configs.read({ app: "shop", machine: "web", digest: "sha256:aaaaaaaaaaaa" })).toBeDefined();
  });
});

describe("fly-rollback", () => {
  test("restores the previous release's Machine config, and names it for the ledger", async () => {
    const s = setup();
    await s.release.run(CTX, input("sha256:aaaaaaaaaaaa", { image: "shop:1" }));
    const one = structuredClone(s.fake.machine("shop", "web")!.config);
    await s.release.run(CTX, input("sha256:bbbbbbbbbbbb", { image: "shop:2" }));
    const back = await s.rollback.run(CTX, { plan: planPath, endpoint: ENDPOINT, wait: NO_WAIT, verify: { intervalMs: 1, timeoutMs: 20 } });
    expect(back).toMatchObject({ uri: "fly://shop/web", digest: "sha256:aaaaaaaaaaaa", gitSha: "aaaaaaa", previous: { digest: "sha256:bbbbbbbbbbbb" } });
    expect(s.fake.machine("shop", "web")!.config).toEqual(one);
  });

  test("with no release before the serving one, it refuses", async () => {
    const s = setup();
    await s.release.run(CTX, input("sha256:aaaaaaaaaaaa"));
    await expect(s.rollback.run(CTX, { plan: planPath, endpoint: ENDPOINT })).rejects.toThrow(/no release before it/);
  });

  test("to a digest with no recorded config, it refuses", async () => {
    const s = setup();
    await s.release.run(CTX, input("sha256:aaaaaaaaaaaa"));
    await expect(s.rollback.run(CTX, { plan: planPath, endpoint: ENDPOINT, to: "sha256:zzz" })).rejects.toThrow(/no recorded Machine config/);
  });
});

describe("components status --live over a Fly release", () => {
  const record = (digest: string): ReleaseRecord => ({
    version: 1,
    component: "web",
    env: "prod",
    digest,
    gitSha: "0000000",
    runId: "run-1",
    timestamp: "2026-09-25T00:00:00.000Z",
    actor: "lex00",
  });

  async function status(fake: MachinesFake, recorded: string) {
    const entities = new Map([
      ["shop", { entityType: "Fly::Machines::App", props: { name: "shop" } as Record<string, unknown> }],
      ["web", { entityType: "Fly::Machines::Machine", props: { name: "web" } as Record<string, unknown> }],
    ]);
    const observed = normalizeObservation(
      await describeResources({ environment: "prod", buildOutput: "", entityNames: ["shop", "web"], entities, endpoint: ENDPOINT }, fake.http),
    );
    const cs = buildChangeSet("prod", { declared: new Set(entities.keys()), observedNow: observed.resources, observedThen: undefined, unobserved: observed.unobserved }, { lexicon: "fly" });
    const observations = new Map<string, EntityLiveRead>(cs.entries.map((e) => [e.name, { now: observed.resources[e.name] }]));
    const evidence = liveEvidenceFromChangeSet(cs, undefined, { observations });
    return reconcileStatus("prod", [record(recorded)], { liveEvidence: evidence }).find((r) => r.component === "web")!;
  }

  test("the Machine's release is compared with the ledger: reconciled when they agree, drifted when not", async () => {
    const s = setup();
    await s.release.run(CTX, input("sha256:aaaaaaaaaaaa"));
    await s.release.run(CTX, input("sha256:bbbbbbbbbbbb"));

    const agreed = await status(s.fake, "sha256:bbbbbbbbbbbb");
    expect(agreed.reconciliation).toBe("reconciled");

    // The Machine rolled back with no ledger record: live and recorded disagree.
    await s.rollback.run(CTX, { plan: planPath, endpoint: ENDPOINT, wait: NO_WAIT, verify: { intervalMs: 1, timeoutMs: 20 } });
    const drifted = await status(s.fake, "sha256:bbbbbbbbbbbb");
    expect(drifted.reconciliation).toBe("drifted");
    expect(drifted.detail).toContain("reports digest sha256:aaaaaaaaaaaa");
  });

  test("the migration receipt is named for the app and migration", () => {
    expect(migrationReceipt("shop", { name: "001.sql", command: "x", sha: "sha256:1" })).toMatchObject({
      ref: { name: "fly-migration:shop/001.sql", effect: "fly-migrate", flavor: "hash" },
      expectation: "sha256:1",
    });
  });
});
