import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { spriteCreate, spriteDelete, spriteExec } from "./sprites";
import { spritesContainerUp, spritesContainerDown } from "./sprites-emulator";

// Acceptance (#2765) against the REAL spritzer image in container exec mode
// (SPRITZER_EXEC=container, SPRITZER_RUNTIME=docker — INTENTIUS/spritzer#22,
// spritzer 0.6.0's CHANGELOG: "Exec runs the real command ... with stdin, env
// and dir"). Interpreter-mode spritzer (the default `sprites.docker.integration.test.ts`
// runs against) has no notion of `env`/`dir` at all — only container mode runs
// a real process, so it is the only place `env`/`dir` reaching the command can
// be proven against spritzer rather than the in-process fake.
// `sprite-services.docker.integration.test.ts` runs the same container-mode
// suite for the Services activities; this file is the `spriteExec` twin.
// Docker required; deterministically skipped in CI (GitHub runners have
// Docker, so relying on absence would pull the image on every run) — run
// locally, or opt in with SPRITES_DOCKER=1, same convention as the other
// docker tests here.

const CONTAINER = "chant-spritzer-exec-opts-it";
const PORT = 4295;
const SPRITE = "chant-2765-exec";

let available = false;
let prevBaseUrl: string | undefined;

beforeAll(async () => {
  if (process.env.CI && !process.env.SPRITES_DOCKER) {
    available = false;
    return;
  }
  try {
    const up = await spritesContainerUp({ name: CONTAINER, port: PORT, timeoutMs: 60_000 });
    prevBaseUrl = process.env.SPRITES_BASE_URL;
    process.env.SPRITES_BASE_URL = up.endpoint;
    available = true;
  } catch {
    available = false;
  }
}, 90_000);

afterAll(async () => {
  if (prevBaseUrl === undefined) delete process.env.SPRITES_BASE_URL;
  else process.env.SPRITES_BASE_URL = prevBaseUrl;
  if (available) {
    await spriteDelete({ id: SPRITE }).catch(() => {});
    await spritesContainerDown({ name: CONTAINER });
  }
}, 30_000);

describe("spriteExec env/dir/timeoutMs against real spritzer 0.6.1, container mode (#2765)", () => {
  test("env reaches the command", async (ctx) => {
    if (!available) ctx.skip();
    await spriteCreate({ name: SPRITE });
    const res = await spriteExec({ id: SPRITE, cmd: "env", env: { CHANT_2765: "hi" } });
    expect(res.stdout).toMatch(/^CHANT_2765=hi$/m);
  }, 30_000);

  test("dir reaches the command", async (ctx) => {
    if (!available) ctx.skip();
    const res = await spriteExec({ id: SPRITE, cmd: "pwd", dir: "/tmp" });
    expect(res.stdout.trim()).toBe("/tmp");
  }, 30_000);

  test("timeoutMs aborts a real hung command", async (ctx) => {
    if (!available) ctx.skip();
    const started = Date.now();
    await expect(spriteExec({ id: SPRITE, cmd: "sleep 30", timeoutMs: 500 })).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);
});
