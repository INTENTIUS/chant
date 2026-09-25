import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flapsUp, flapsDown } from "./flaps";
import { defaultFlyHttp, deleteApp } from "./fly-apply";
import { findMachine } from "./machine-release";
import { readMachineRelease } from "../../release-metadata";
import { createFlyReleaseCapability, createFlyRollbackCapability } from "../../components/fly-release";
import { memoryMachineConfigStore } from "../../release-store";
import { describeResources } from "../../describe-resources";
import type { EffectReceiptRef } from "@intentius/chant/op/receipt-store";

// A release, a migration, a second release and a rollback against a live
// mudflaps container (#2736): the `fly-release` / `fly-rollback` capabilities
// over the real Machines wire protocol, then describeResources reading the
// release back the way `chant components status --live` does. Docker is
// required; the suite skips in CI unless a job opts in with FLY_IT=1, like
// ./fly-apply.integration.test.ts. No Fly credentials: mudflaps ignores tokens.

const APP = "chant-release-it";
const CONTAINER = "chant-mudflaps-release-it";
const PORT = 4284;
const WAIT = { intervalMs: 50, timeoutSecs: 5, deadlineMs: 30_000 };
const http = defaultFlyHttp();

let endpoint = "";
let available = false;
let tmp = "";

beforeAll(async () => {
  if (process.env.CI && !process.env.FLY_IT) return;
  tmp = mkdtempSync(join(tmpdir(), "fly-release-it-"));
  try {
    endpoint = (await flapsUp({ name: CONTAINER, port: PORT, timeoutMs: 30_000 })).endpoint;
    available = true;
  } catch {
    available = false;
  }
}, 60_000);

afterAll(async () => {
  if (available) {
    await deleteApp({ base: endpoint }, APP, http).catch(() => undefined);
    await flapsDown({ name: CONTAINER });
  }
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("fly-release against mudflaps", () => {
  test("release, migrate, release again, roll back; the Machine's metadata names each release", async (ctx) => {
    if (!available) ctx.skip();
    const planPath = join(tmp, "fly.json");
    writeFileSync(
      planPath,
      JSON.stringify({
        app: { endpoint: "/v1/apps", method: "POST", body: { app_name: APP, org_slug: "personal" } },
        web: {
          endpoint: `/v1/apps/${APP}/machines`,
          method: "POST",
          body: { name: "web", region: "iad", config: { image: "nginx:1", metadata: { "managed-by": "chant" } } },
        },
      }),
    );
    const configs = memoryMachineConfigStore();
    const receipts = new Map<string, string>();
    const deps = {
      http,
      configStore: () => configs,
      receiptStore: () => ({
        read: async (r: EffectReceiptRef) => receipts.get(r.name),
        write: async (r: EffectReceiptRef, v: string) => void receipts.set(r.name, v),
      }),
      headCommit: async () => "1111111111111111111111111111111111111111",
      log: () => undefined,
    };
    const release = createFlyReleaseCapability(deps);
    const rollback = createFlyRollbackCapability(deps);
    const c = { env: "it", component: "web" };
    const common = { plan: planPath, endpoint, wait: WAIT, verify: { intervalMs: 100, timeoutMs: 10_000 } };

    const one = await release.run(c, { ...common, digest: "sha256:one", image: "nginx:1", migrations: [{ name: "001.sql", command: "echo migrate 001" }] });
    expect(one.migrations).toEqual([{ name: "001.sql", fired: true }]);
    const two = await release.run(c, { ...common, digest: "sha256:two", image: "nginx:2", migrations: [{ name: "001.sql", command: "echo migrate 001" }] });
    expect(two.migrations).toEqual([{ name: "001.sql", fired: false }]);
    expect(two.previous?.digest).toBe("sha256:one");

    let m = await findMachine({ base: endpoint }, APP, "web", http);
    expect(readMachineRelease(m?.config?.metadata)).toMatchObject({ digest: "sha256:two", previousDigest: "sha256:one" });
    expect(m?.config?.image).toBe("nginx:2");

    const observed = await describeResources(
      {
        environment: "it",
        buildOutput: "",
        entityNames: ["app", "web"],
        entities: new Map([
          ["app", { entityType: "Fly::Machines::App", props: { name: APP } }],
          ["web", { entityType: "Fly::Machines::Machine", props: { name: "web" } }],
        ]),
        endpoint,
      },
      http,
    );
    expect((observed.resources.web?.attributes as { digest?: string }).digest).toBe("sha256:two");

    const back = await rollback.run(c, { plan: planPath, endpoint, wait: WAIT, verify: { intervalMs: 100, timeoutMs: 10_000 } });
    expect(back.digest).toBe("sha256:one");
    m = await findMachine({ base: endpoint }, APP, "web", http);
    expect(m?.config?.image).toBe("nginx:1");
    expect(readMachineRelease(m?.config?.metadata)?.digest).toBe("sha256:one");
  }, 120_000);
});
