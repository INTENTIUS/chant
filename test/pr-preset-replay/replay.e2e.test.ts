/**
 * The pull request preset replay (#5118) as an on-demand test: reruns chant
 * over the saved corpus and fails when the preset misses its bar. It needs the
 * corpus on disk, so it skips unless CHANT_REPLAY_CORPUS names it:
 *
 *   CHANT_REPLAY_CORPUS=<dir> npx vitest run --project e2e test/pr-preset-replay
 *
 * CHANT_REPLAY_WORK keeps the per-commit reports between runs. A cold run
 * takes about an hour; `just replay-pr-preset <dir>` runs the harness alone.
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const corpus = process.env.CHANT_REPLAY_CORPUS;

describe.skipIf(!corpus)("the pull request preset replay (#5118)", () => {
  test(
    "meets the bar on the saved corpus",
    () => {
      const r = spawnSync("npx", ["tsx", join(import.meta.dirname, "replay.ts"), "--corpus", corpus!], {
        encoding: "utf-8",
        env: process.env,
        maxBuffer: 64 * 1024 * 1024,
      });
      expect(r.stderr.split("\n").filter((l) => l.startsWith("FAIL:"))).toEqual([]);
      expect(r.status).toBe(0);
    },
    4 * 60 * 60 * 1000,
  );
});
