import { describe, test, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { archiveSourceTree } from "@intentius/chant/op/source-archive";
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

describe("fly-release with a source tree (#2782)", () => {
  function archived() {
    const repo = join(dir, "repo");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
    mkdirSync(join(repo, "app/migrations"), { recursive: true });
    writeFileSync(join(repo, "app/server.js"), "console.log('serving');\n");
    writeFileSync(join(repo, "app/migrations/0001_init.sql"), "CREATE TABLE t (id INTEGER);\n");
    git("init", "-q", "-b", "main");
    git("-c", "user.email=t@t", "-c", "user.name=t", "add", "-A");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "app");
    return archiveSourceTree({ dir: "app", cwd: repo });
  }

  test("puts the approved tree on the Machine with its start command, and a retry changes nothing", async () => {
    const s = setup();
    const a = archived();
    const source = { archive: a.archive, digest: a.digest, dir: a.dir, start: "node server.js" };
    const first = await s.release.run(CTX, input("sha256:aaaaaaaaaaaa", { source }));
    const m = s.fake.machine("shop", "web")!;
    const files = m.config.files as Array<{ guest_path: string; raw_value: string }>;
    expect(files.map((f) => f.guest_path).sort()).toEqual(["/srv/app/migrations/0001_init.sql", "/srv/app/server.js"]);
    expect(Buffer.from(files.find((f) => f.guest_path === "/srv/app/server.js")!.raw_value, "base64").toString()).toBe("console.log('serving');\n");
    expect(m.config.init).toEqual({ cmd: ["sh", "-c", "cd /srv/app && exec node server.js"] });
    expect(m.config.image).toBe("shop:declared");
    expect(first.digest).toBe("sha256:aaaaaaaaaaaa");

    const calls = s.fake.calls.length;
    await s.release.run(CTX, input("sha256:aaaaaaaaaaaa", { source }));
    // The same release again: the Machine's config is unchanged, so nothing is updated.
    expect(s.fake.calls.slice(calls).filter((c) => c.startsWith("POST") && !c.endsWith("/wait"))).toEqual([]);
  });

  test("an archive that is not the approved digest is refused before the Machine changes", async () => {
    const s = setup();
    const a = archived();
    await expect(
      s.release.run(CTX, input("sha256:aaaaaaaaaaaa", { source: { archive: a.archive, digest: "sha256:0000", dir: a.dir, start: "node server.js" } })),
    ).rejects.toThrow(/not the approved sha256:0000/);
    expect(s.fake.calls.filter((c) => c.startsWith("POST"))).toEqual([]);
  });
});

describe("fly-rollback with a source tree (#2800)", () => {
  /** Two commits of an app, each archived. */
  function twoReleases() {
    const repo = join(dir, "repo2");
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo, stdio: "pipe" });
    mkdirSync(join(repo, "app"), { recursive: true });
    git("init", "-q", "-b", "main");
    const commit = (body: string, out: string) => {
      writeFileSync(join(repo, "app/server.js"), body);
      git("add", "-A");
      git("commit", "-q", "-m", body);
      return archiveSourceTree({ dir: "app", cwd: repo, out });
    };
    return { a: commit("console.log('a');\n", "a.tar"), b: commit("console.log('b');\n", "b.tar") };
  }
  const src = (x: { archive: string; digest: string; dir: string }) => ({ archive: x.archive, digest: x.digest, dir: x.dir });
  const rollbackInput = (to: string, source: ReturnType<typeof src>) => ({ plan: planPath, endpoint: ENDPOINT, wait: NO_WAIT, verify: { intervalMs: 1, timeoutMs: 20 }, to, source });

  test("puts back the recorded config of the release whose tree it is, and a rerun changes nothing", async () => {
    const s = setup();
    const { a, b } = twoReleases();
    await s.release.run(CTX, input("sha256:aaaaaaaaaaaa", { source: { ...src(a), start: "node server.js" } }));
    const one = structuredClone(s.fake.machine("shop", "web")!.config);
    await s.release.run(CTX, input("sha256:bbbbbbbbbbbb", { source: { ...src(b), start: "node server.js" } }));
    expect(s.fake.machine("shop", "web")!.config).not.toEqual(one);

    const back = await s.rollback.run(CTX, rollbackInput("sha256:aaaaaaaaaaaa", src(a)));
    expect(back).toMatchObject({ digest: "sha256:aaaaaaaaaaaa", previous: { digest: "sha256:bbbbbbbbbbbb" } });
    const m = s.fake.machine("shop", "web")!;
    expect(m.config).toEqual(one);
    const server = (m.config.files as Array<{ guest_path: string; raw_value: string }>).find((f) => f.guest_path === "/srv/app/server.js")!;
    expect(Buffer.from(server.raw_value, "base64").toString()).toBe("console.log('a');\n");

    const calls = s.fake.calls.length;
    await s.rollback.run(CTX, rollbackInput("sha256:aaaaaaaaaaaa", src(a)));
    expect(s.fake.calls.slice(calls).filter((c) => c.startsWith("POST") && !c.endsWith("/wait"))).toEqual([]);
    expect(s.fake.machine("shop", "web")!.config).toEqual(one);
  });

  test("an archive that is not its digest is refused before any flaps call", async () => {
    const s = setup();
    const { a, b } = twoReleases();
    await s.release.run(CTX, input("sha256:aaaaaaaaaaaa", { source: { ...src(a), start: "node server.js" } }));
    await s.release.run(CTX, input("sha256:bbbbbbbbbbbb", { source: { ...src(b), start: "node server.js" } }));
    const calls = s.fake.calls.length;
    await expect(s.rollback.run(CTX, rollbackInput("sha256:aaaaaaaaaaaa", { ...src(a), digest: b.digest }))).rejects.toThrow(/not the approved/);
    expect(s.fake.calls.length).toBe(calls);
  });

  test("a recorded config that does not carry the tree is refused, and the Machine is left as it is", async () => {
    const s = setup();
    const { a, b } = twoReleases();
    await s.release.run(CTX, input("sha256:aaaaaaaaaaaa", { source: { ...src(a), start: "node server.js" } }));
    await s.release.run(CTX, input("sha256:bbbbbbbbbbbb", { source: { ...src(b), start: "node server.js" } }));
    const serving = structuredClone(s.fake.machine("shop", "web")!.config);
    await expect(s.rollback.run(CTX, rollbackInput("sha256:aaaaaaaaaaaa", src(b)))).rejects.toThrow(/does not carry the tree .*\/srv\/app\/server\.js has other bytes/);
    expect(s.fake.machine("shop", "web")!.config).toEqual(serving);
  });

  test("a release with no recorded Machine config is refused by name", async () => {
    const s = setup();
    const { a, b } = twoReleases();
    await s.release.run(CTX, input("sha256:bbbbbbbbbbbb", { source: { ...src(b), start: "node server.js" } }));
    await expect(s.rollback.run(CTX, rollbackInput("sha256:aaaaaaaaaaaa", src(a)))).rejects.toThrow("fly-rollback: no recorded Machine config for sha256:aaaaaaaaaaaa on shop/web");
  });
});
