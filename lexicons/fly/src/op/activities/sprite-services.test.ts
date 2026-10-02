import { describe, test, expect, beforeAll, afterAll } from "vitest";
import type { SpritesHttp } from "./sprites";
import { spriteCreate as createImpl } from "./sprites";
import { createSpritesFake } from "./sprites-fake";
import {
  spriteServiceCreate,
  spriteServiceGet,
  spriteServiceList,
  spriteServiceStart,
  spriteServiceStop,
  spriteServiceDelete,
  spriteServiceLogs,
  spriteServiceCreateBody,
  parseServiceLogNdjson,
} from "./sprite-services";

// A recording HTTP stub: captures every call and answers from a callback.
function recorder(answer: (method: string, url: string, body?: unknown) => { status: number; text: string }) {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const http: SpritesHttp = async (method, url, body) => {
    calls.push({ method, url, body });
    return answer(method, url, body);
  };
  return { http, calls };
}

const running = (name: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ name, cmd: "run", state: { name, status: "running", pid: 4321 }, ...extra });

// ── Pure helpers ────────────────────────────────────────────────────────────

describe("spriteServiceCreateBody", () => {
  test("omits undefined optional fields", () => {
    expect(spriteServiceCreateBody({ id: "s", name: "web", cmd: "run-web" })).toEqual({ cmd: "run-web" });
  });

  test("includes every field that is set", () => {
    expect(
      spriteServiceCreateBody({
        id: "s",
        name: "web",
        cmd: "python3",
        args: ["-m", "http.server", "8080"],
        env: { PORT: "8080" },
        dir: "/app",
        needs: ["db"],
        http_port: 8080,
      }),
    ).toEqual({
      cmd: "python3",
      args: ["-m", "http.server", "8080"],
      env: { PORT: "8080" },
      dir: "/app",
      needs: ["db"],
      http_port: 8080,
    });
  });
});

describe("parseServiceLogNdjson", () => {
  test("keeps stdout/stderr data in order, drops the complete marker", () => {
    const text = [
      JSON.stringify({ type: "started", data: "web started (pid 1)" }),
      JSON.stringify({ type: "stdout", data: "Serving on 0.0.0.0:8080" }),
      JSON.stringify({ type: "complete", data: "ignored" }),
    ].join("\n");
    expect(parseServiceLogNdjson(text)).toEqual(["web started (pid 1)", "Serving on 0.0.0.0:8080"]);
  });

  test("skips blank and unparseable lines", () => {
    expect(parseServiceLogNdjson('\n{"type":"stdout","data":"a"}\n\nnot json\n')).toEqual(["a"]);
  });
});

// ── Activity request shapes (injected SpritesHttp) ─────────────────────────

describe("spriteServiceCreate", () => {
  test("PUTs .../services/{name} with ?duration, then GETs the definitive state", async () => {
    const { http, calls } = recorder((method) => ({
      status: method === "PUT" ? 200 : 200,
      text: method === "PUT" ? '{"type":"complete"}' : running("web", { http_port: 8080 }),
    }));
    const res = await spriteServiceCreate(
      { id: "task-1", name: "web", cmd: "python3", args: ["-m", "http.server", "8080"], http_port: 8080, endpoint: "http://x" },
      undefined,
      http,
    );
    expect(res.state.status).toBe("running");
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].url).toBe("http://x/v1/sprites/task-1/services/web?duration=500ms");
    expect(calls[0].body).toEqual({ cmd: "python3", args: ["-m", "http.server", "8080"], http_port: 8080 });
    expect(calls[1].method).toBe("GET");
    expect(calls[1].url).toBe("http://x/v1/sprites/task-1/services/web");
  });

  test("a custom durationMs is passed through as ms", async () => {
    const { http, calls } = recorder(() => ({ status: 200, text: running("web") }));
    await spriteServiceCreate({ id: "t", name: "web", cmd: "x", durationMs: 2000, endpoint: "http://x" }, undefined, http);
    expect(calls[0].url).toBe("http://x/v1/sprites/t/services/web?duration=2000ms");
  });

  test("throws when the resulting state is failed", async () => {
    const { http } = recorder((method) => ({
      status: 200,
      text: method === "PUT"
        ? '{"type":"error","data":"boom"}'
        : JSON.stringify({ name: "web", cmd: "x", state: { name: "web", status: "failed", error: "exec: not found" } }),
    }));
    await expect(
      spriteServiceCreate({ id: "t", name: "web", cmd: "nope", endpoint: "http://x" }, undefined, http),
    ).rejects.toThrow(/failed to start.*exec: not found/);
  });

  test("throws on a non-2xx PUT", async () => {
    const { http } = recorder(() => ({ status: 400, text: "bad request" }));
    await expect(
      spriteServiceCreate({ id: "t", name: "web", cmd: "x", endpoint: "http://x" }, undefined, http),
    ).rejects.toThrow(/create failed \(400\)/);
  });
});

describe("spriteServiceGet", () => {
  test("GETs .../services/{name}", async () => {
    const { http, calls } = recorder(() => ({ status: 200, text: running("web") }));
    const res = await spriteServiceGet({ id: "t", name: "web", endpoint: "http://x" }, undefined, http);
    expect(res.state.status).toBe("running");
    expect(calls[0].url).toBe("http://x/v1/sprites/t/services/web");
  });
});

describe("spriteServiceList", () => {
  test("GETs .../services and returns the array", async () => {
    const list = [JSON.parse(running("web")), JSON.parse(running("db"))];
    const { http, calls } = recorder(() => ({ status: 200, text: JSON.stringify(list) }));
    const res = await spriteServiceList({ id: "t", endpoint: "http://x" }, undefined, http);
    expect(res).toEqual(list);
    expect(calls[0].url).toBe("http://x/v1/sprites/t/services");
  });
});

describe("spriteServiceStart / spriteServiceStop", () => {
  test("start POSTs .../start?duration and re-GETs", async () => {
    const { http, calls } = recorder((method) => ({
      status: 200,
      text: method === "POST" ? '{"type":"complete"}' : running("web"),
    }));
    const res = await spriteServiceStart({ id: "t", name: "web", endpoint: "http://x" }, undefined, http);
    expect(res.state.status).toBe("running");
    expect(calls[0].url).toBe("http://x/v1/sprites/t/services/web/start?duration=500ms");
  });

  test("stop POSTs .../stop and re-GETs", async () => {
    const { http, calls } = recorder((method) => ({
      status: 200,
      text: method === "POST"
        ? '{"type":"complete"}'
        : JSON.stringify({ name: "web", cmd: "x", state: { name: "web", status: "stopped" } }),
    }));
    const res = await spriteServiceStop({ id: "t", name: "web", endpoint: "http://x" }, undefined, http);
    expect(res.state.status).toBe("stopped");
    expect(calls[0].url).toBe("http://x/v1/sprites/t/services/web/stop");
  });

  test("stop passes ?timeout when timeoutMs is set", async () => {
    const { http, calls } = recorder((method) => ({
      status: 200,
      text: method === "POST" ? "{}" : running("web"),
    }));
    await spriteServiceStop({ id: "t", name: "web", timeoutMs: 3000, endpoint: "http://x" }, undefined, http);
    expect(calls[0].url).toBe("http://x/v1/sprites/t/services/web/stop?timeout=3000ms");
  });
});

describe("spriteServiceDelete", () => {
  test("DELETEs .../services/{name}", async () => {
    const { http, calls } = recorder(() => ({ status: 200, text: "{}" }));
    await spriteServiceDelete({ id: "t", name: "web", endpoint: "http://x" }, undefined, http);
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url).toBe("http://x/v1/sprites/t/services/web");
  });

  test("a 404 is idempotent, not an error", async () => {
    const { http } = recorder(() => ({ status: 404, text: "gone" }));
    await expect(spriteServiceDelete({ id: "t", name: "web", endpoint: "http://x" }, undefined, http)).resolves.toEqual({});
  });
});

describe("spriteServiceLogs", () => {
  test("GETs .../logs and returns the parsed tail", async () => {
    const { http, calls } = recorder(() => ({
      status: 200,
      text: [JSON.stringify({ type: "stdout", data: "line 1" }), JSON.stringify({ type: "complete" })].join("\n"),
    }));
    const res = await spriteServiceLogs({ id: "t", name: "web", endpoint: "http://x" }, undefined, http);
    expect(res).toEqual({ lines: ["line 1"] });
    expect(calls[0].url).toBe("http://x/v1/sprites/t/services/web/logs");
  });

  test("passes ?lines when set", async () => {
    const { http, calls } = recorder(() => ({ status: 200, text: "" }));
    await spriteServiceLogs({ id: "t", name: "web", lines: 5, endpoint: "http://x" }, undefined, http);
    expect(calls[0].url).toBe("http://x/v1/sprites/t/services/web/logs?lines=5");
  });
});

// ── End to end against the in-process fake (S7, no Docker) ────────────────
//
// The acceptance scenario from #2711, offline: create a sprite, create a
// service with http_port, list/get it, stop and start it, delete it. The
// docker-gated `sprite-services.docker.integration.test.ts` runs the same
// scenario against real spritzer 0.6.0 in container mode.

let fake: { url: string; close(): Promise<void> };
let prevBaseUrl: string | undefined;

beforeAll(async () => {
  fake = await createSpritesFake();
  prevBaseUrl = process.env.SPRITES_BASE_URL;
  process.env.SPRITES_BASE_URL = fake.url;
});

afterAll(async () => {
  if (prevBaseUrl === undefined) delete process.env.SPRITES_BASE_URL;
  else process.env.SPRITES_BASE_URL = prevBaseUrl;
  await fake?.close();
});

describe("sprite services against the in-process fake (#2711)", () => {
  test("create, get, list, stop, start, delete", async () => {
    await createImpl({ name: "svc-fake-1" });

    const created = await spriteServiceCreate({
      id: "svc-fake-1",
      name: "web",
      cmd: "python3",
      args: ["-m", "http.server", "8080"],
      http_port: 8080,
    });
    expect(created.state.status).toBe("running");

    const got = await spriteServiceGet({ id: "svc-fake-1", name: "web" });
    expect(got.name).toBe("web");
    expect(got.http_port).toBe(8080);

    const list = await spriteServiceList({ id: "svc-fake-1" });
    expect(list.map((s) => s.name)).toEqual(["web"]);

    const stopped = await spriteServiceStop({ id: "svc-fake-1", name: "web" });
    expect(stopped.state.status).toBe("stopped");

    const restarted = await spriteServiceStart({ id: "svc-fake-1", name: "web" });
    expect(restarted.state.status).toBe("running");

    const logs = await spriteServiceLogs({ id: "svc-fake-1", name: "web" });
    expect(logs.lines.length).toBeGreaterThan(0);

    await spriteServiceDelete({ id: "svc-fake-1", name: "web" });
    await expect(spriteServiceGet({ id: "svc-fake-1", name: "web" })).rejects.toThrow(/get failed \(404\)/);

    // A second delete is idempotent.
    await expect(spriteServiceDelete({ id: "svc-fake-1", name: "web" })).resolves.toEqual({});
  });
});
