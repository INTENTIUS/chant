import { describe, test, expect, beforeAll, afterAll } from "vitest";
import {
  loadActivities,
  runOpLocally,
  phase,
  spriteCreate,
  spriteExec,
  spriteWriteFile,
  spriteReadFile,
  type ActivityFn,
  type ActivityProfile,
  type OpConfig,
} from "@intentius/chant/op";
import { createSpritesFake } from "./sprites-fake";
import { spriteCreate as createImpl } from "./sprites";
import {
  spriteWriteFile as writeImpl,
  spriteReadFile as readImpl,
  spriteListDir as listImpl,
  spriteRemove as removeImpl,
  spriteFsUrl,
} from "./sprite-fs";

// Filesystem activities (#848) end-to-end against the in-process fake (S7) — no
// Docker, runs in CI. Direct-impl calls cover the return values; an Op-level
// stage → process → collect proves they resolve by name and compose.

const PROFILES: Record<string, ActivityProfile> = {
  longInfra: { startToCloseTimeout: "5m", retry: { maximumAttempts: 3, initialInterval: "1ms", backoffCoefficient: 1 } },
  fastIdempotent: { startToCloseTimeout: "5m", retry: { maximumAttempts: 2, initialInterval: "1ms", backoffCoefficient: 1 } },
};

let fake: { url: string; close(): Promise<void> };
let activities: Map<string, ActivityFn>;
let prevBaseUrl: string | undefined;

beforeAll(async () => {
  fake = await createSpritesFake();
  prevBaseUrl = process.env.SPRITES_BASE_URL;
  process.env.SPRITES_BASE_URL = fake.url;
  activities = await loadActivities(["fly"]);
});

afterAll(async () => {
  if (prevBaseUrl === undefined) delete process.env.SPRITES_BASE_URL;
  else process.env.SPRITES_BASE_URL = prevBaseUrl;
  await fake?.close();
});

async function inspect(id: string): Promise<{ fs: Record<string, string> }> {
  const res = await fetch(`${fake.url}/v1/sprites/${id}`);
  return (await res.json()) as { fs: Record<string, string> };
}

describe("spriteFsUrl (pure)", () => {
  test("builds a query string, dropping unset params", () => {
    expect(spriteFsUrl("http://h", "s 1", "write", { path: "/a", mkdir: true, mode: undefined, workingDir: "" })).toBe(
      "http://h/v1/sprites/s%201/fs/write?path=%2Fa&mkdir=true",
    );
  });
  test("no params → no query", () => {
    expect(spriteFsUrl("http://h", "s", "read", {})).toBe("http://h/v1/sprites/s/fs/read");
  });
});

describe("fs activities resolve by name", () => {
  test("loadActivities([\"fly\"]) exposes the four fs activities", () => {
    for (const fn of ["spriteWriteFile", "spriteReadFile", "spriteListDir", "spriteRemove"]) {
      expect(typeof activities.get(fn)).toBe("function");
    }
  });
});

describe("write → read → list → remove round-trip", () => {
  test("round-trips against the fake, remove is idempotent", async () => {
    await createImpl({ name: "fs-1", endpoint: fake.url });

    await writeImpl({ id: "fs-1", path: "/work/input", content: "hello", endpoint: fake.url });
    expect((await readImpl({ id: "fs-1", path: "/work/input", endpoint: fake.url })).content).toBe("hello");

    await writeImpl({ id: "fs-1", path: "/work/notes/a.txt", content: "x", endpoint: fake.url });
    const list = await listImpl({ id: "fs-1", path: "/work", endpoint: fake.url });
    expect(list).toEqual(
      expect.arrayContaining([
        { name: "notes", type: "dir" },
        { name: "input", type: "file", size: 5 },
      ]),
    );

    await removeImpl({ id: "fs-1", path: "/work/input", endpoint: fake.url });
    await expect(readImpl({ id: "fs-1", path: "/work/input", endpoint: fake.url })).rejects.toThrow(/not found/);
    // Idempotent: removing an already-gone path is a no-op (404 tolerated).
    await expect(removeImpl({ id: "fs-1", path: "/work/input", endpoint: fake.url })).resolves.toBeDefined();
  });

  test("reading a missing file throws not-found", async () => {
    await createImpl({ name: "fs-2", endpoint: fake.url });
    await expect(readImpl({ id: "fs-2", path: "/nope", endpoint: fake.url })).rejects.toThrow(/not found/);
  });

  test("recursive remove clears a whole subtree", async () => {
    await createImpl({ name: "fs-3", endpoint: fake.url });
    await writeImpl({ id: "fs-3", path: "/d/a", content: "1", endpoint: fake.url });
    await writeImpl({ id: "fs-3", path: "/d/sub/b", content: "2", endpoint: fake.url });
    await removeImpl({ id: "fs-3", path: "/d", recursive: true, endpoint: fake.url });
    expect(await listImpl({ id: "fs-3", path: "/d", endpoint: fake.url })).toEqual([]);
  });
});

describe("Op-level stage → process → collect (the example flow)", () => {
  test("write input, exec copies it, read output — runs green by-name", async () => {
    const op: OpConfig = {
      name: "fs-agent-task",
      overview: "stage an input file, process it, collect the result",
      taskQueue: "sprites",
      phases: [
        phase("Create", [spriteCreate({ name: "fs-op-1" })]),
        phase("Stage", [spriteWriteFile({ id: "fs-op-1", path: "/work/input", content: "hello" })]),
        phase("Run", [spriteExec({ id: "fs-op-1", cmd: "cat /work/input > /work/output" })]),
        phase("Collect", [spriteReadFile({ id: "fs-op-1", path: "/work/output" })]),
      ],
    };
    const result = await runOpLocally(op, activities, PROFILES);
    expect(result.ok).toBe(true);
    expect(result.records.map((r) => r.fn)).toEqual([
      "spriteCreate",
      "spriteWriteFile",
      "spriteExec",
      "spriteReadFile",
    ]);
    expect(result.records.every((r) => r.status === "ok")).toBe(true);

    const state = await inspect("fs-op-1");
    expect(state.fs["/work/output"]).toBe("hello");
  });
});
