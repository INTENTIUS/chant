import { describe, test, expect } from "vitest";
import {
  resolveSpritesEndpoint,
  defaultSpritesHttp,
  spriteCreateBody,
  spriteExecBody,
  spriteCheckpointBody,
  parseCreateResponse,
  parseExecResponse,
  parseCheckpointResponse,
  parseCheckpointsResponse,
  pickCheckpointByComment,
  spriteCreate,
  spriteExec,
  spriteCheckpoint,
  spriteRestore,
  spriteDestroy,
  DEFAULT_SPRITES_BASE_URL,
  type SpritesHttp,
} from "./sprites";

// A recording HTTP stub: captures every call and answers from a queue/map.
function recorder(answer: (method: string, url: string, body?: unknown) => { status: number; text: string }) {
  const calls: Array<{ method: string; url: string; body?: unknown; headers?: Record<string, string> }> = [];
  const http: SpritesHttp = async (method, url, body, headers) => {
    calls.push({ method, url, body, headers });
    return answer(method, url, body);
  };
  return { http, calls };
}

// ── Endpoint resolution (S3) ──────────────────────────────────────────────────

describe("resolveSpritesEndpoint (S3)", () => {
  test("explicit arg wins and trailing slash is stripped", () => {
    expect(resolveSpritesEndpoint({ endpoint: "http://localhost:9000/" }, {} as NodeJS.ProcessEnv)).toBe(
      "http://localhost:9000",
    );
  });

  test("SPRITES_BASE_URL env when no arg", () => {
    expect(resolveSpritesEndpoint({}, { SPRITES_BASE_URL: "http://fake:9000" } as NodeJS.ProcessEnv)).toBe(
      "http://fake:9000",
    );
  });

  test("arg beats env", () => {
    expect(
      resolveSpritesEndpoint({ endpoint: "http://arg:1" }, { SPRITES_BASE_URL: "http://env:2" } as NodeJS.ProcessEnv),
    ).toBe("http://arg:1");
  });

  test("default is real Sprites", () => {
    expect(resolveSpritesEndpoint({}, {} as NodeJS.ProcessEnv)).toBe(DEFAULT_SPRITES_BASE_URL);
  });
});

// ── Pure request/response mappers ─────────────────────────────────────────────

describe("request/response mappers", () => {
  test("spriteCreateBody includes only the fields set", () => {
    expect(spriteCreateBody({ name: "a" })).toEqual({ name: "a" });
    expect(spriteCreateBody({ name: "a", image: "img", size: "sm", policy: { net: "off" } })).toEqual({
      name: "a",
      image: "img",
      size: "sm",
      policy: { net: "off" },
    });
  });

  test("parseCreateResponse falls back to the caller name as id (S4)", () => {
    expect(parseCreateResponse('{"url":"http://h/s/a"}', "a")).toEqual({ id: "a", url: "http://h/s/a" });
    expect(parseCreateResponse('{"id":"srv-1","url":"u"}', "a")).toEqual({ id: "srv-1", url: "u" });
    expect(parseCreateResponse("not-json", "a")).toEqual({ id: "a", url: "" });
  });

  test("spriteExecBody carries cmd and optional timeout", () => {
    expect(spriteExecBody({ id: "a", cmd: "ls" })).toEqual({ cmd: "ls" });
    expect(spriteExecBody({ id: "a", cmd: "ls", timeoutMs: 500 })).toEqual({ cmd: "ls", timeoutMs: 500 });
  });

  test("parseExecResponse defaults missing fields", () => {
    expect(parseExecResponse('{"stdout":"hi","stderr":"","exitCode":0}')).toEqual({ stdout: "hi", stderr: "", exitCode: 0 });
    expect(parseExecResponse("{}")).toEqual({ stdout: "", stderr: "", exitCode: 0 });
  });

  test("spriteCheckpointBody carries only the comment when set", () => {
    expect(spriteCheckpointBody({ id: "a" })).toEqual({});
    expect(spriteCheckpointBody({ id: "a", comment: "pre-run" })).toEqual({ comment: "pre-run" });
    // `label` stays a trivial alias for `comment` (backward compat).
    expect(spriteCheckpointBody({ id: "a", label: "pre-run" })).toEqual({ comment: "pre-run" });
  });

  test("parseCheckpointResponse reads the server-assigned version id", () => {
    expect(parseCheckpointResponse('{"id":"v3"}')).toEqual({ checkpointId: "v3" });
    expect(parseCheckpointResponse("{}")).toEqual({ checkpointId: "" });
  });

  test("parseCheckpointsResponse maps { id, comment } in order, dropping malformed entries", () => {
    expect(
      parseCheckpointsResponse('{"checkpoints":[{"id":"v1","comment":"pre-run"},{"id":"v2"},{"comment":"x"}]}'),
    ).toEqual([{ id: "v1", comment: "pre-run" }, { id: "v2" }]);
    expect(parseCheckpointsResponse("{}")).toEqual([]);
  });
});

// ── pickCheckpointByComment (newest wins) ─────────────────────────────────────

describe("pickCheckpointByComment", () => {
  const list = [
    { id: "v1", comment: "pre-run" },
    { id: "v2", comment: "other" },
    { id: "v3", comment: "pre-run" },
    { id: "v4" },
  ];

  test("returns the NEWEST checkpoint carrying the comment (creation order, newest last)", () => {
    expect(pickCheckpointByComment(list, "pre-run")).toEqual({ id: "v3", comment: "pre-run" });
    expect(pickCheckpointByComment(list, "other")).toEqual({ id: "v2", comment: "other" });
  });

  test("returns undefined when no checkpoint matches", () => {
    expect(pickCheckpointByComment(list, "nope")).toBeUndefined();
    expect(pickCheckpointByComment([], "pre-run")).toBeUndefined();
  });
});

// ── Per-activity request shape + response parse (injected SpritesHttp) ─────────

describe("spriteCreate", () => {
  test("POSTs /v1/sprites with the name and parses { id, url }", async () => {
    const { http, calls } = recorder(() => ({ status: 201, text: JSON.stringify({ id: "task-1", url: "http://h/s/task-1" }) }));
    const res = await spriteCreate({ name: "task-1", endpoint: "http://x:9000", image: "base:1" }, undefined, http);
    expect(res).toEqual({ id: "task-1", url: "http://h/s/task-1" });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("http://x:9000/v1/sprites");
    expect(calls[0].body).toEqual({ name: "task-1", image: "base:1" });
  });

  test("throws on a non-2xx create", async () => {
    const { http } = recorder(() => ({ status: 500, text: "boom" }));
    await expect(spriteCreate({ name: "task-1", endpoint: "http://x" }, undefined, http)).rejects.toThrow(/create failed/);
  });
});

describe("spriteExec", () => {
  test("POSTs /v1/sprites/{id}/exec and returns stdout/stderr/exitCode", async () => {
    const { http, calls } = recorder(() => ({ status: 200, text: JSON.stringify({ stdout: "ok", stderr: "", exitCode: 0 }) }));
    const res = await spriteExec({ id: "task-1", cmd: "echo ok", endpoint: "http://x" }, undefined, http);
    expect(res).toEqual({ stdout: "ok", stderr: "", exitCode: 0 });
    expect(calls[0].url).toBe("http://x/v1/sprites/task-1/exec");
    expect(calls[0].body).toEqual({ cmd: "echo ok" });
  });

  test("a non-zero exit throws (so a risky step fails its phase, S5)", async () => {
    const { http } = recorder(() => ({ status: 200, text: JSON.stringify({ stdout: "", stderr: "nope", exitCode: 1 }) }));
    await expect(spriteExec({ id: "task-1", cmd: "./risky.sh", endpoint: "http://x" }, undefined, http)).rejects.toThrow(
      /exited 1/,
    );
  });
});

describe("spriteCheckpoint", () => {
  test("POSTs /v1/sprites/{id}/checkpoints with the comment and returns the server id", async () => {
    const { http, calls } = recorder(() => ({ status: 201, text: JSON.stringify({ id: "v1" }) }));
    const res = await spriteCheckpoint({ id: "task-1", comment: "pre-run", endpoint: "http://x" }, undefined, http);
    expect(res).toEqual({ checkpointId: "v1" });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("http://x/v1/sprites/task-1/checkpoints");
    expect(calls[0].body).toEqual({ comment: "pre-run" });
  });

  test("omits the body comment when none is given", async () => {
    const { http, calls } = recorder(() => ({ status: 201, text: JSON.stringify({ id: "v2" }) }));
    await spriteCheckpoint({ id: "task-1", endpoint: "http://x" }, undefined, http);
    expect(calls[0].body).toEqual({});
  });
});

describe("spriteRestore", () => {
  // A recording stub that also answers GET .../checkpoints from a fixed list.
  function restoreRecorder(list: Array<{ id: string; comment?: string }>) {
    return recorder((method, url) => {
      if (method === "GET" && url.endsWith("/checkpoints")) {
        return { status: 200, text: JSON.stringify({ checkpoints: list }) };
      }
      return { status: 200, text: "{}" };
    });
  }

  test("explicit checkpoint id restores by id in the path, no list lookup (S5)", async () => {
    const { http, calls } = recorder(() => ({ status: 200, text: "{}" }));
    const res = await spriteRestore({ id: "task-1", checkpoint: "v7", endpoint: "http://x" }, undefined, http);
    expect(res).toEqual({});
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("http://x/v1/sprites/task-1/checkpoints/v7/restore");
  });

  test("comment restores the NEWEST matching checkpoint's id", async () => {
    const { http, calls } = restoreRecorder([
      { id: "v1", comment: "pre-run" },
      { id: "v2", comment: "other" },
      { id: "v3", comment: "pre-run" },
    ]);
    await spriteRestore({ id: "task-1", comment: "pre-run", endpoint: "http://x" }, undefined, http);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe("http://x/v1/sprites/task-1/checkpoints");
    expect(calls[1].method).toBe("POST");
    expect(calls[1].url).toBe("http://x/v1/sprites/task-1/checkpoints/v3/restore");
  });

  test("no comment and no id restores the newest checkpoint (latest fallback)", async () => {
    const { http, calls } = restoreRecorder([
      { id: "v1", comment: "pre-run" },
      { id: "v2", comment: "later" },
    ]);
    await spriteRestore({ id: "task-1", endpoint: "http://x" }, undefined, http);
    expect(calls[1].url).toBe("http://x/v1/sprites/task-1/checkpoints/v2/restore");
  });

  test("throws when no checkpoint carries the comment", async () => {
    const { http } = restoreRecorder([{ id: "v1", comment: "pre-run" }]);
    await expect(
      spriteRestore({ id: "task-1", comment: "nope", endpoint: "http://x" }, undefined, http),
    ).rejects.toThrow(/no checkpoint with comment "nope"/);
  });

  test("throws on the latest fallback when the sprite has no checkpoints", async () => {
    const { http } = restoreRecorder([]);
    await expect(spriteRestore({ id: "task-1", endpoint: "http://x" }, undefined, http)).rejects.toThrow(
      /no checkpoints to restore/,
    );
  });

  test("propagates a non-2xx restore as an error", async () => {
    const { http } = recorder(() => ({ status: 404, text: "gone" }));
    await expect(
      spriteRestore({ id: "task-1", checkpoint: "v9", endpoint: "http://x" }, undefined, http),
    ).rejects.toThrow(/restore to "v9" failed/);
  });
});

describe("spriteDestroy", () => {
  test("DELETEs /v1/sprites/{id}", async () => {
    const { http, calls } = recorder(() => ({ status: 200, text: "{}" }));
    await spriteDestroy({ id: "task-1", endpoint: "http://x" }, undefined, http);
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url).toBe("http://x/v1/sprites/task-1");
  });

  test("a 404 is idempotent (already gone), not an error", async () => {
    const { http } = recorder(() => ({ status: 404, text: "gone" }));
    await expect(spriteDestroy({ id: "task-1", endpoint: "http://x" }, undefined, http)).resolves.toEqual({});
  });
});

// ── Bearer header on the default client ───────────────────────────────────────

describe("defaultSpritesHttp bearer header", () => {
  test("sends Authorization: Bearer <token> when a token is set", async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    const fakeFetch = (async (_url: string, init: { headers?: Record<string, string> }) => {
      seen.push(init.headers);
      return { status: 200, text: async () => "{}" } as unknown as Response;
    }) as unknown as typeof fetch;
    const http = defaultSpritesHttp("secret-token", fakeFetch);
    await http("GET", "http://x/v1/sprites/task-1");
    expect(seen[0]?.authorization).toBe("Bearer secret-token");
  });

  test("no Authorization header when no token is set", async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    const fakeFetch = (async (_url: string, init: { headers?: Record<string, string> }) => {
      seen.push(init?.headers);
      return { status: 200, text: async () => "{}" } as unknown as Response;
    }) as unknown as typeof fetch;
    // Guard against a real SPRITES_API_TOKEN in the environment.
    const prev = process.env.SPRITES_API_TOKEN;
    delete process.env.SPRITES_API_TOKEN;
    try {
      const http = defaultSpritesHttp(undefined, fakeFetch);
      await http("GET", "http://x/v1/sprites/task-1");
      expect(seen[0]?.authorization).toBeUndefined();
    } finally {
      if (prev !== undefined) process.env.SPRITES_API_TOKEN = prev;
    }
  });
});
