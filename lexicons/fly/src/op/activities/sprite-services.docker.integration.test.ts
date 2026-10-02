import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { spriteCreate, spriteDelete, spriteUrl } from "./sprites";
import { spriteServiceCreate, spriteServiceStop, spriteServiceStart } from "./sprite-services";
import { spritesContainerUp, spritesContainerDown } from "./sprites-emulator";

// Acceptance (#2711) against the REAL spritzer image in container exec mode
// (SPRITZER_EXEC=container, SPRITZER_RUNTIME=docker — INTENTIUS/spritzer#22):
// create a sprite, create a service running `python3 -m http.server 8080`,
// wait for its URL to answer, stop it (the URL stops answering), start it
// again (the URL answers again), delete the sprite. `sprite-services.test.ts`
// runs the same scenario against the in-process fake, no Docker. Docker
// required; deterministically skipped in CI (GitHub runners have Docker, so
// relying on absence would pull the image on every run) — run locally, or
// opt in with SPRITES_DOCKER=1, same convention as the other docker tests
// here.
//
// Cleanup: the sprite container spritzer makes (`spritzer-<name>`) is removed
// by `spriteDelete` before spritzer itself comes down; `docker ps -a` after
// this suite should show neither.

const CONTAINER = "chant-spritzer-container-it";
const PORT = 4294;
const SPRITE = "chant-2711-web";

let available = false;
let endpoint = "";
let prevBaseUrl: string | undefined;

beforeAll(async () => {
  if (process.env.CI && !process.env.SPRITES_DOCKER) {
    available = false;
    return;
  }
  try {
    const up = await spritesContainerUp({ name: CONTAINER, port: PORT, timeoutMs: 60_000 });
    endpoint = up.endpoint;
    prevBaseUrl = process.env.SPRITES_BASE_URL;
    process.env.SPRITES_BASE_URL = endpoint;
    available = true;
  } catch {
    available = false;
  }
}, 90_000);

afterAll(async () => {
  if (prevBaseUrl === undefined) delete process.env.SPRITES_BASE_URL;
  else process.env.SPRITES_BASE_URL = prevBaseUrl;
  if (available) {
    // Idempotent: already deleted by the test on the happy path. A failed
    // test still leaves no sprite container behind.
    await spriteDelete({ id: SPRITE }).catch(() => {});
    await spritesContainerDown({ name: CONTAINER });
  }
}, 30_000);

describe("sprite services against real spritzer 0.6.0, container mode (#2711)", () => {
  test("create → url waits and answers → stop → url stops answering → start → answers again → delete", async (ctx) => {
    if (!available) ctx.skip();

    await spriteCreate({ name: SPRITE });

    await spriteServiceCreate({
      id: SPRITE,
      name: "web",
      cmd: "python3",
      args: ["-m", "http.server", "8080"],
      http_port: 8080,
      durationMs: 1000,
    });

    const { url } = await spriteUrl({ id: SPRITE, path: "/", timeoutMs: 20_000, intervalMs: 500 });
    expect(url).toContain(SPRITE);

    await spriteServiceStop({ id: SPRITE, name: "web" });
    // The process is gone; nothing answers on the sprite URL any more.
    const afterStop = await fetch(`${url}/`);
    expect(afterStop.status).toBe(503);

    await spriteServiceStart({ id: SPRITE, name: "web" });
    const { url: url2 } = await spriteUrl({ id: SPRITE, path: "/", timeoutMs: 20_000, intervalMs: 500 });
    expect(url2).toBe(url);

    await spriteDelete({ id: SPRITE });
    const afterDelete = await fetch(`${endpoint}/v1/sprites/${SPRITE}`);
    expect(afterDelete.status).toBe(404);
  }, 120_000);
});
