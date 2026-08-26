/**
 * Typed step-builder wrappers (chant #1288 Stage 2) — see
 * `lexicons/k8s/src/op/builders.test.ts`'s module doc for what's asserted
 * and why. Unlike the positional-arg lexicons, the sprite family takes one
 * whole args object (matching core's original inline-typed signature), so
 * only `profile` is extracted from that object — `id` is left alone
 * (verified below): it's a required DOMAIN field on most of these (the
 * target sprite), not step-authoring sugar, so `.out`-by-id is out of scope
 * here (see `./builders.ts`'s module doc).
 */

import { describe, test, expect } from "vitest";
import {
  spriteCreate as spriteCreateOld,
  spriteExec as spriteExecOld,
  spriteWriteFile as spriteWriteFileOld,
  spritesUp as spritesUpOld,
  spritesDown as spritesDownOld,
  stepOutput,
} from "@intentius/chant/op";
import { spriteCreate, spriteExec, spriteWriteFile, spritesUp, spritesDown } from "./builders";

describe("fly typed sprite step builders (#1288 Stage 2)", () => {
  test("spriteCreate: identical ActivityStep to core's original", () => {
    expect(spriteCreate({ name: "sandbox" })).toEqual(spriteCreateOld({ name: "sandbox" }));
    const args = { name: "sandbox", image: "custom:latest", size: "shared-cpu-1x" };
    expect(spriteCreate(args)).toEqual(spriteCreateOld(args));
  });

  test("spriteExec: identical ActivityStep to core's original", () => {
    const args = { id: "sandbox", cmd: "npm test", timeoutMs: 60_000 };
    expect(spriteExec(args)).toEqual(spriteExecOld(args));
  });

  test("spriteWriteFile: identical ActivityStep to core's original", () => {
    const args = { id: "sandbox", path: "/app/config.json", content: "{}" };
    expect(spriteWriteFile(args)).toEqual(spriteWriteFileOld(args));
  });

  test("spritesUp/spritesDown: identical ActivityStep to core's original, including the no-arg default", () => {
    expect(spritesUp()).toEqual(spritesUpOld());
    expect(spritesUp({ port: 4291 })).toEqual(spritesUpOld({ port: 4291 }));
    expect(spritesDown()).toEqual(spritesDownOld());
  });

  test("spriteCreate: accepts a StepOutputRef in a typed slot", () => {
    const ref = stepOutput("resolve-image", "image");
    const step = spriteCreate({ name: "sandbox", image: ref });
    expect(step.args?.image).toBe(ref);
  });

  test("spriteExec: `id` (the target sprite, a domain field) lands in args, not the step's own id", () => {
    const step = spriteExec({ id: "sandbox", cmd: "npm test" });
    expect(step.args?.id).toBe("sandbox");
    expect(step.id).toBeUndefined();
  });
});

// ── Compile-time-only: authoring-time type errors (never executed) ──────────
function _typeChecksOnly(): void {
  // @ts-expect-error — name is required (the activity fails without it).
  spriteCreate({});

  // @ts-expect-error — "sandbox_id" is not a key of SpriteExecArgs (the field is `id`).
  spriteExec({ sandbox_id: "sandbox", cmd: "npm test" });

  // @ts-expect-error — timeoutMs must be a number.
  spriteExec({ id: "sandbox", cmd: "npm test", timeoutMs: "60000" });

  // @ts-expect-error — spritesUp's port must be a number.
  spritesUp({ port: "4290" });
}
void _typeChecksOnly;
