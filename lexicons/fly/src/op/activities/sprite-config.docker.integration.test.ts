import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { spritesUp, spritesDown } from "./sprites-emulator";
import { spriteCreate } from "./sprites";
import { spriteWriteFile, spriteReadFile, spriteListDir, spriteRemove } from "./sprite-fs";
import { spriteApplyNetworkPolicy, spriteApplyServices } from "./sprite-config";
import { spriteTaskCreate, spriteTaskRelease } from "./sprite-tasks";

// The filesystem / config-reconcile / keep-alive activities driven against the
// REAL spritzer image (ghcr.io/intentius/spritzer), booted via `spritesUp` — the
// twin of the lifecycle docker test. Proves the image serves these endpoints
// with the same wire shape the in-process fake does. Docker required;
// deterministically skipped in CI unless SPRITES_DOCKER=1.

const CONTAINER = "chant-spritzer-config-it";
const PORT = 4294;

let available = false;
let endpoint = "";

async function inspect(id: string): Promise<{
  fs: Record<string, string>;
  netPolicy: Array<{ domain: string; action: string }>;
  services: Record<string, { state: { status: string } }>;
  tasks: Record<string, unknown>;
}> {
  const res = await fetch(`${endpoint}/v1/sprites/${id}`);
  return (await res.json()) as never;
}

beforeAll(async () => {
  if (process.env.CI && !process.env.SPRITES_DOCKER) {
    available = false;
    return;
  }
  try {
    const up = await spritesUp({ name: CONTAINER, port: PORT, timeoutMs: 30_000 });
    endpoint = up.endpoint;
    available = true;
  } catch {
    available = false;
  }
}, 60_000);

afterAll(async () => {
  if (available) await spritesDown({ name: CONTAINER });
});

describe("fs / config / tasks activities against real spritzer", () => {
  test("filesystem round-trips (write → read → list → remove)", async (ctx) => {
    if (!available) ctx.skip();
    await spriteCreate({ name: "d-fs", endpoint });
    await spriteWriteFile({ id: "d-fs", path: "/work/input", content: "hello", endpoint });
    expect((await spriteReadFile({ id: "d-fs", path: "/work/input", endpoint })).content).toBe("hello");
    await spriteWriteFile({ id: "d-fs", path: "/work/notes/a", content: "x", endpoint });
    const list = await spriteListDir({ id: "d-fs", path: "/work", endpoint });
    expect(list.map((e) => e.name).sort()).toEqual(["input", "notes"]);
    await spriteRemove({ id: "d-fs", path: "/work/input", endpoint });
    await expect(spriteReadFile({ id: "d-fs", path: "/work/input", endpoint })).rejects.toThrow(/not found/);
  });

  test("network policy reconcile converges", async (ctx) => {
    if (!available) ctx.skip();
    await spriteCreate({ name: "d-np", endpoint });
    const rules = [
      { domain: "api.anthropic.com", action: "allow" as const },
      { domain: "*", action: "deny" as const },
    ];
    expect((await spriteApplyNetworkPolicy({ id: "d-np", rules, endpoint })).changed).toBe(true);
    expect((await spriteApplyNetworkPolicy({ id: "d-np", rules, endpoint })).changed).toBe(false);
    expect((await inspect("d-np")).netPolicy).toEqual(rules);
  });

  test("services reconcile creates + starts in dependency order", async (ctx) => {
    if (!available) ctx.skip();
    await spriteCreate({ name: "d-svc", endpoint });
    const r = await spriteApplyServices({
      id: "d-svc",
      start: true,
      endpoint,
      services: [
        { name: "web", cmd: "run-web", needs: ["db"], http_port: 8080 },
        { name: "db", cmd: "run-db" },
      ],
    });
    expect(r.started).toEqual(["db", "web"]);
    expect((await inspect("d-svc")).services.web.state.status).toBe("running");
  });

  test("keep-alive task holds then releases (idempotent)", async (ctx) => {
    if (!available) ctx.skip();
    await spriteCreate({ name: "d-task", endpoint });
    await spriteTaskCreate({ id: "d-task", name: "session", expire: "5m", endpoint });
    expect(Object.keys((await inspect("d-task")).tasks)).toEqual(["session"]);
    await spriteTaskRelease({ id: "d-task", name: "session", endpoint });
    expect(Object.keys((await inspect("d-task")).tasks)).toEqual([]);
    await expect(spriteTaskRelease({ id: "d-task", name: "session", endpoint })).resolves.toBeDefined();
  });
});
