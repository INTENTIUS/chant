import { describe, test, expect } from "vitest";
import {
  resolveSpritesEndpoint,
  DEFAULT_SPRITES_BASE_URL,
  accumulateExecFrames,
  parseCheckpointNdjson,
  pickCheckpointByComment,
  splitCommand,
  spriteExecWsUrl,
  defaultSpritesHttp,
  spriteCreate,
  spriteCheckpoint,
  spriteRestore,
  listCheckpoints,
  spriteDestroy,
  type SpritesHttp,
  type Checkpoint,
} from "./sprites";

const enc = new TextEncoder();

/** Build one exec frame `[stream][payload]`. */
function frame(stream: number, payload?: string | number[]): Uint8Array {
  const body = typeof payload === "string" ? enc.encode(payload) : Uint8Array.from(payload ?? []);
  return Uint8Array.from([stream, ...body]);
}

// A recording HTTP stub: captures every call and answers from a callback.
function recorder(answer: (method: string, url: string, body?: unknown) => { status: number; text: string }) {
  const calls: Array<{ method: string; url: string; body?: unknown; headers?: Record<string, string> }> = [];
  const http: SpritesHttp = async (method, url, body, headers) => {
    calls.push({ method, url, body, headers });
    return answer(method, url, body);
  };
  return { http, calls };
}

// ── Exec frame accumulator (the WS framing, socket-free) ──────────────────────

describe("accumulateExecFrames", () => {
  test("stdout then exit 0", () => {
    expect(accumulateExecFrames([frame(1, "hi\n"), frame(3, [0])])).toEqual({
      stdout: "hi\n",
      stderr: "",
      exitCode: 0,
    });
  });

  test("stderr then exit 1", () => {
    expect(accumulateExecFrames([frame(2, "err"), frame(3, [1])])).toEqual({
      stdout: "",
      stderr: "err",
      exitCode: 1,
    });
  });

  test("concatenates multiple stdout frames and ignores stdin/eof frames", () => {
    const frames = [frame(1, "foo"), frame(0), frame(1, "bar"), frame(2, "warn"), frame(4), frame(3, [7])];
    expect(accumulateExecFrames(frames)).toEqual({ stdout: "foobar", stderr: "warn", exitCode: 7 });
  });

  test("no exit frame defaults exitCode to 0; empty frames are skipped", () => {
    expect(accumulateExecFrames([new Uint8Array(0), frame(1, "x")])).toEqual({
      stdout: "x",
      stderr: "",
      exitCode: 0,
    });
  });

  test("a multi-byte character split across two stdout frames decodes intact", () => {
    // "€" is E2 82 AC; split after the first byte across two frames.
    expect(accumulateExecFrames([frame(1, [0xe2]), frame(1, [0x82, 0xac]), frame(3, [0])]).stdout).toBe("€");
  });
});

// ── Checkpoint NDJSON parsing ─────────────────────────────────────────────────

describe("parseCheckpointNdjson", () => {
  test("mines the version id from real Sprites' message text (type/data shape)", () => {
    // Verbatim shape from api.sprites.dev: no structured id field — the version
    // rides inside the "  ID: v1" detail line and the completion message.
    const body = [
      '{"type":"info","data":"Creating checkpoint...","time":"2026-07-12T05:01:17Z"}',
      '{"type":"info","data":"Checkpoint created successfully"}',
      '{"type":"info","data":"  ID: v1"}',
      '{"type":"info","data":"  Path: checkpoints/v1"}',
      '{"type":"complete","data":"Checkpoint v1 created successfully"}',
    ].join("\n");
    expect(parseCheckpointNdjson(body)).toEqual({ checkpointId: "v1" });
  });

  test("honors a structured id from the older {event, id} shape", () => {
    const body = '{"event":"info","message":"checkpointing"}\n{"event":"complete","id":"v3"}\n';
    expect(parseCheckpointNdjson(body)).toEqual({ checkpointId: "v3" });
  });

  test("blank and unparseable lines are skipped; no id → empty", () => {
    expect(parseCheckpointNdjson('\n{"event":"info"}\nnot-json\n')).toEqual({ checkpointId: "" });
  });
});

// ── Comment picker (newest match) ─────────────────────────────────────────────

describe("pickCheckpointByComment", () => {
  const list: Checkpoint[] = [
    { id: "v1", comment: "pre-run", create_time: "2026-01-01T00:00:00.000Z", is_auto: false },
    { id: "v2", comment: "other", create_time: "2026-01-01T00:00:01.000Z", is_auto: false },
    { id: "v3", comment: "pre-run", create_time: "2026-01-01T00:00:02.000Z", is_auto: false },
  ];

  test("returns the newest checkpoint carrying the comment", () => {
    expect(pickCheckpointByComment(list, "pre-run")?.id).toBe("v3");
  });

  test("returns undefined when nothing matches", () => {
    expect(pickCheckpointByComment(list, "nope")).toBeUndefined();
  });
});

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

// ── Command tokenizing + exec WS url ──────────────────────────────────────────

describe("splitCommand", () => {
  test("splits on whitespace and respects quotes", () => {
    expect(splitCommand("echo hi")).toEqual(["echo", "hi"]);
    expect(splitCommand('sh -c "exit 7"')).toEqual(["sh", "-c", "exit 7"]);
    expect(splitCommand("echo bad > /state; false")).toEqual(["echo", "bad", ">", "/state;", "false"]);
  });
});

describe("spriteExecWsUrl", () => {
  test("http → ws with cmd/path/stdin/cc params", () => {
    const url = new URL(spriteExecWsUrl("http://x:9000", "task-1", "echo hi"));
    expect(url.protocol).toBe("ws:");
    expect(url.pathname).toBe("/v1/sprites/task-1/exec");
    expect(url.searchParams.getAll("cmd")).toEqual(["echo", "hi"]);
    expect(url.searchParams.get("path")).toBe("echo");
    expect(url.searchParams.get("stdin")).toBe("false");
    expect(url.searchParams.get("cc")).toBe("true");
  });

  test("https → wss", () => {
    expect(spriteExecWsUrl("https://api.sprites.dev", "s", "ls").startsWith("wss://api.sprites.dev/")).toBe(true);
  });
});

// ── Activity request shapes (injected SpritesHttp; no real sockets) ───────────

describe("spriteCreate", () => {
  test("POSTs /v1/sprites with the name and parses { id, url }", async () => {
    const { http, calls } = recorder(() => ({
      status: 201,
      text: JSON.stringify({ id: "sprite-1", url: "http://h/s/task-1" }),
    }));
    const res = await spriteCreate({ name: "task-1", endpoint: "http://x:9000", image: "base:1" }, undefined, http);
    expect(res).toEqual({ id: "sprite-1", url: "http://h/s/task-1" });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("http://x:9000/v1/sprites");
    expect(calls[0].body).toEqual({ name: "task-1", image: "base:1" });
  });
});

describe("spriteCheckpoint", () => {
  test("POSTs the singular /checkpoint with the comment and reads the NDJSON complete id", async () => {
    const { http, calls } = recorder(() => ({
      status: 200,
      text: '{"event":"info"}\n{"event":"complete","id":"v5"}\n',
    }));
    const res = await spriteCheckpoint({ id: "task-1", comment: "pre-run", endpoint: "http://x" }, undefined, http);
    expect(res).toEqual({ checkpointId: "v5" });
    expect(calls[0].url).toBe("http://x/v1/sprites/task-1/checkpoint");
    expect(calls[0].body).toEqual({ comment: "pre-run" });
  });

  test("omits the comment key when empty", async () => {
    const { http, calls } = recorder(() => ({ status: 200, text: '{"event":"complete","id":"v1"}\n' }));
    await spriteCheckpoint({ id: "task-1", endpoint: "http://x" }, undefined, http);
    expect(calls[0].body).toBeUndefined();
  });
});

describe("listCheckpoints", () => {
  test("GETs the plural /checkpoints and returns the array", async () => {
    const list = [{ id: "v1", comment: "pre-run", create_time: "2026-01-01T00:00:00.000Z", is_auto: false }];
    const { http, calls } = recorder(() => ({ status: 200, text: JSON.stringify(list) }));
    const res = await listCheckpoints({ id: "task-1", endpoint: "http://x" }, undefined, http);
    expect(res).toEqual(list);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe("http://x/v1/sprites/task-1/checkpoints");
  });
});

describe("spriteRestore", () => {
  test("explicit checkpoint id → POST /checkpoints/{id}/restore", async () => {
    const { http, calls } = recorder(() => ({ status: 200, text: '{"event":"complete","id":"v2"}\n' }));
    const res = await spriteRestore({ id: "task-1", checkpoint: "v2", endpoint: "http://x" }, undefined, http);
    expect(res).toEqual({});
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("http://x/v1/sprites/task-1/checkpoints/v2/restore");
  });

  test("comment → list, pick newest match, then restore that id", async () => {
    const list: Checkpoint[] = [
      { id: "v1", comment: "pre-run", create_time: "2026-01-01T00:00:00.000Z", is_auto: false },
      { id: "v4", comment: "pre-run", create_time: "2026-01-01T00:00:09.000Z", is_auto: false },
    ];
    const { http, calls } = recorder((method) =>
      method === "GET"
        ? { status: 200, text: JSON.stringify(list) }
        : { status: 200, text: '{"event":"complete","id":"v4"}\n' },
    );
    await spriteRestore({ id: "task-1", comment: "pre-run", endpoint: "http://x" }, undefined, http);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe("http://x/v1/sprites/task-1/checkpoints");
    expect(calls[1].url).toBe("http://x/v1/sprites/task-1/checkpoints/v4/restore");
  });

  test("throws when no checkpoint carries the comment", async () => {
    const { http } = recorder(() => ({ status: 200, text: "[]" }));
    await expect(
      spriteRestore({ id: "task-1", comment: "nope", endpoint: "http://x" }, undefined, http),
    ).rejects.toThrow(/no checkpoint matching comment "nope"/);
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
