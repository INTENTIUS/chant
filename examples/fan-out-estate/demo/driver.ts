/**
 * The fan-out demo's driver (#4091, design in #4085 sections 1, 2 and 4).
 *
 *   npm run demo -- up      build and start the stack, make the people, the
 *                           repo and the bucket, push the base and apply it.
 *                           Run once.
 *   npm run demo -- cycle   play one cycle: the change fails cluster-a, the
 *                           fix applies the seven, and the reset puts the
 *                           base back. Exits 1 on a stall.
 *   npm run demo -- loop    play cycles until stopped (Ctrl-C ends the loop
 *                           after the cycle in progress).
 *   npm run demo -- reset   put the forge repo and the stacks back to the base.
 *   npm run demo -- down    stop the stack and remove its volumes
 *                           (`down --purge` also removes the state directory).
 *
 * The cycle itself is lib/cycle.ts, against the forge, the bucket and chant
 * as interfaces (lib/ports.ts). This file wires the real ones: Forgejo
 * (lib/forgejo.ts), floci's S3 (lib/bucket.ts) and the checkout's chant
 * (lib/chant.ts). The state (tokens, the reviewer's key, the base tree) lives
 * outside the checkout, in CHANT_FAN_OUT_DEMO_STATE or
 * ~/.local/state/chant-fan-out-demo.
 */
import { pathToFileURL } from "node:url";
import { BUCKET } from "./steps.js";
import { FlociBucket } from "./lib/bucket.js";
import { RealChant } from "./lib/chant.js";
import { DemoCycleRun, lastCycle, resetToBase, writeBase, type CycleOutcome } from "./lib/cycle.js";
import { ForgejoForge } from "./lib/forgejo.js";
import { overlayFiles } from "./lib/overlays.js";
import { realClock, type Log } from "./lib/ports.js";
import {
  JOB_IMAGE,
  PROJECT,
  baseTreeOf,
  down,
  flociUrl,
  forgeUrl,
  readyState,
  reviewerKeyOf,
  stackConfig,
  up,
  type StackConfig,
} from "./lib/stack.js";

const log: Log = (line) => console.error(`[demo] ${line}`);

/** The real forge, bucket and chant, from up's state. */
function wire(c: StackConfig) {
  const s = readyState(c);
  const clock = realClock;
  const bucket = new FlociBucket(flociUrl(c), BUCKET);
  const forge = new ForgejoForge({ url: forgeUrl(c), admin: s.admin, author: s.author, reviewer: s.reviewer, baseTree: baseTreeOf(c), clock });
  const chant = new RealChant({
    forgeUrl: forgeUrl(c),
    reviewer: s.reviewer,
    reviewerKey: reviewerKeyOf(c),
    baseTree: baseTreeOf(c),
    jobImage: JOB_IMAGE,
    network: PROJECT,
  });
  return { clock, bucket, forge, chant, baseSha: s.baseSha };
}

async function oneCycle(c: StackConfig): Promise<CycleOutcome> {
  const w = wire(c);
  const n = (await lastCycle(w.bucket)) + 1;
  log(`cycle ${n} starts`);
  const outcome = await new DemoCycleRun(n, { ...w, overlays: overlayFiles, log }).run();
  log(outcome.status === "applied" ? `cycle ${n} applied and published` : `cycle ${n} stalled after ${outcome.after}: ${outcome.reason}`);
  return outcome;
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const c = stackConfig();
  switch (cmd) {
    case "up": {
      const s = await up(c, realClock, log);
      const w = wire(c);
      log("applying the base with chant run --components all --env demo");
      await w.chant.applyBase();
      await writeBase(w.bucket, w.clock, await lastCycle(w.bucket), s.baseSha!);
      log(`up: Forgejo at ${forgeUrl(c)}, floci at ${flociUrl(c)}, base ${s.baseSha!.slice(0, 8)}`);
      return 0;
    }
    case "cycle":
      return (await oneCycle(c)).status === "applied" ? 0 : 1;
    case "loop": {
      let stop = false;
      process.on("SIGINT", () => {
        if (stop) process.exit(130);
        stop = true;
        log("stopping after this cycle (Ctrl-C again to stop now)");
      });
      while (!stop) await oneCycle(c);
      return 0;
    }
    case "reset": {
      const w = wire(c);
      await resetToBase(w.forge, w.chant, w.baseSha);
      await writeBase(w.bucket, w.clock, await lastCycle(w.bucket), w.baseSha);
      return 0;
    }
    case "down":
      await down(c, rest.includes("--purge"));
      return 0;
    default:
      console.error("usage: npm run demo -- up | loop | cycle | reset | down [--purge]");
      return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      log(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
