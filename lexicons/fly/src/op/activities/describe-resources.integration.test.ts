import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flapsUp, flapsDown } from "./flaps";
import { flyApply, defaultFlyHttp } from "./fly-apply";
import { describeResources, flyPlan } from "../../describe-resources";

// End-to-end against a live mudflaps container (the #740 wrapper), proving the
// read-back seam (#767) against real wire behavior: flyApply writes, then
// describeResources reads it back with the right ownership verdict, and the
// declared-vs-live plan classifies create/noop/delete without ever deleting an
// unmarked machine. Docker is required; CI skips cleanly (same guard as
// fly-apply.integration.test.ts).

const APP = "chant-desc-it";
const CONTAINER = "chant-mudflaps-desc-it";
const PORT = 4282;
const http = defaultFlyHttp();
const WAIT = { intervalMs: 50, timeoutSecs: 5, deadlineMs: 30_000 };

let endpoint = "";
let available = false;
let tmp = "";

function planFile(name: string, plan: Record<string, unknown>): string {
  const path = join(tmp, `${name}.json`);
  writeFileSync(path, JSON.stringify(plan));
  return path;
}

const appReq = { endpoint: "/v1/apps", method: "POST", body: { app_name: APP, org_slug: "personal" } };
const machineReq = (image: string) => ({
  endpoint: `/v1/apps/${APP}/machines`,
  method: "POST",
  body: { name: "web", region: "iad", config: { image, metadata: { "managed-by": "chant" } } },
});

/** entities map keyed by declared entity name (props unused by describeResources). */
function entities(pairs: Array<[string, string]>) {
  return new Map(pairs.map(([name, entityType]) => [name, { entityType, props: {} as Record<string, unknown> }]));
}

beforeAll(async () => {
  if (process.env.CI && !process.env.FLY_IT) {
    available = false;
    return;
  }
  tmp = mkdtempSync(join(tmpdir(), "fly-desc-it-"));
  try {
    const up = await flapsUp({ name: CONTAINER, port: PORT, timeoutMs: 30_000 });
    endpoint = up.endpoint;
    available = true;
  } catch {
    available = false;
  }
}, 60_000);

afterAll(async () => {
  if (available) await flapsDown({ name: CONTAINER });
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe("describeResources against live mudflaps (#767)", () => {
  test("applied machine reads back owned; unmarked reads foreign; removed owned → delete, unmarked never deletes", async (ctx) => {
    if (!available) ctx.skip();

    // 1. Apply an App + owned Machine via flyApply.
    const buildOutput = JSON.stringify({ app: appReq, web: machineReq("nginx:1") });
    await flyApply({ planPath: planFile("v1", { app: appReq, web: machineReq("nginx:1") }), endpoint, wait: WAIT });

    // 2. Plant an UNMARKED machine directly (no managed-by: chant).
    const plant = await http("POST", `${endpoint}/v1/apps/${APP}/machines`, { name: "legacy", region: "iad", config: { image: "redis:1" } });
    expect(plant.status).toBe(200);

    const ents = entities([["app", "Fly::Machines::App"], ["web", "Fly::Machines::Machine"]]);

    // 3. describeResources sees web owned, legacy foreign.
    const live = await describeResources({ environment: "it", buildOutput, entityNames: [...ents.keys()], entities: ents, endpoint });
    expect(live.resources.web?.ownership).toBe("owned");
    expect(live.resources.web?.status).toBe("started");
    expect(live.resources.legacy?.ownership).toBe("foreign");
    expect(live.resources.app?.ownership).toBe("owned"); // app-boundary: carries an owned machine

    // 4. The owned filter drops the unmarked machine.
    const ownedOnly = await describeResources({ environment: "it", buildOutput, entityNames: [...ents.keys()], entities: ents, owned: true, endpoint });
    expect(ownedOnly.resources.web?.ownership).toBe("owned");
    expect(ownedOnly.resources.legacy).toBeUndefined();

    // 5. Drop "web" from the declared plan. The plan now classifies the live
    //    owned "web" as a delete; the unmarked "legacy" stays adopt (never delete).
    const removedOutput = JSON.stringify({ app: appReq });
    const { changeSet } = await flyPlan({
      environment: "it",
      buildOutput: removedOutput,
      entityNames: ["app"],
      entities: entities([["app", "Fly::Machines::App"]]),
      endpoint,
    });
    const action = (name: string) => changeSet.entries.find((e) => e.name === name)?.action;
    expect(action("web")).toBe("delete"); // owned + undeclared
    expect(action("legacy")).toBe("adopt"); // unmarked + undeclared → never a delete
    expect(changeSet.entries.some((e) => e.action === "delete" && e.name === "legacy")).toBe(false);
  }, 120_000);
});
