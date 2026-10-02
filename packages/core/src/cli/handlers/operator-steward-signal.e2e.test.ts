/**
 * #2872 — `chant operator --steward` releases its lease on a repeated
 * SIGTERM.
 *
 * A supervisor that signals both a process group and a child (arugula-salad
 * /studio's box smoke does exactly this) sends a second SIGTERM close behind
 * the first. `process.once("SIGTERM", onSigint)` tears the listener down the
 * instant it fires the first time — before `onSigint` even runs, let alone
 * before the `finally` block that releases the steward's lease — so that
 * second signal finds nothing listening and takes Node's default
 * disposition: the process ends right there. The next `chant operator
 * --steward` then refuses with "already running (lease held by ...)" until
 * the stale lease expires.
 *
 * This spawns the real CLI (not the handler in-process) so a broken fix
 * kills only the child, never the test runner itself, the way `process.once`
 * would if it were still there. See ../../cli/handlers/operator.ts around
 * "chant operator --steward" for the fix (`process.on`, kept registered for
 * the whole shutdown).
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { cleanScratch, repo, REPO } from "../../workspace/__fixtures__/contract-repo";
import { readLease } from "../../lifecycle/lease";
import { stewardLeaseName } from "../../op/steward";

const MAIN = join(REPO, "packages/core/src/cli/main.ts");
const LOADER = pathToFileURL(join(REPO, "node_modules/tsx/dist/loader.mjs")).href;
const CHANT = [process.execPath, "--import", LOADER, MAIN];

/** The shape `declareSteward({ name: "box-steward", ops: [] })` returns — written as a literal so the fixture's `ops/steward.op.ts` needs no import to resolve. */
const STEWARD_DECLARATION = {
  kind: "Chant::Steward",
  name: "box-steward",
  ops: [],
  form: { default: "local", environments: {} },
};

afterAll(() => cleanScratch());

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("chant operator --steward — a repeated SIGTERM (#2872)", () => {
  test("repeated SIGTERMs sent in quick succession still release the steward's lease and exit 0", async () => {
    const dir = repo(
      {
        "chant.config.ts": "export default { lexicons: [] };\n",
        "ops/steward.op.ts": `export const steward = ${JSON.stringify(STEWARD_DECLARATION)};\n`,
      },
      true,
    );

    const child = spawn(
      CHANT[0],
      [...CHANT.slice(1), "operator", "--steward", "--interval", "200ms"],
      { cwd: dir, env: { ...process.env, NO_COLOR: "1", TSX_DISABLE_CACHE: "1" } },
    );
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    const exited = new Promise<number | null>((resolve) => child.on("close", resolve));

    // Wait until the steward has actually acquired its lease — a running,
    // mid-loop process — rather than firing signals at one still starting up
    // (tsx's cold start is not instant).
    const deadline = Date.now() + 15_000;
    for (;;) {
      const { record } = await readLease(stewardLeaseName("box-steward"), { cwd: dir });
      if (record) break;
      if (Date.now() > deadline) {
        child.kill("SIGKILL");
        throw new Error(`the steward never acquired its lease; stderr so far:\n${stderr}`);
      }
      await sleep(50);
    }

    // A SIGTERM, then more every few ms until the child is gone, each given
    // a moment to reach the child's event loop before the next. With
    // `process.once`, the first one's auto-removal happens the instant it
    // fires, so the second finds no listener left and the process exits
    // right there, skipping the `finally` that releases the lease. Firing
    // until the child closes (not a fixed three) also covers the stretch
    // after that `finally`, up to `process.exit`: when the handler removed
    // its listeners there, a SIGTERM arriving in that stretch ended the
    // process by signal (exit code null) though the lease was released. With
    // three signals 30ms apart that failed CI now and then (runs
    // 36357297831, 36358285603, 36368551353); signalling to the end hit it
    // every time.
    let closed = false;
    child.on("close", () => (closed = true));
    for (let sent = 0; !closed && sent < 1000; sent++) {
      child.kill("SIGTERM");
      await sleep(5);
    }

    const code = await exited;
    expect(code, `chant operator --steward did not exit cleanly; stderr:\n${stderr}`).toBe(0);

    const { record } = await readLease(stewardLeaseName("box-steward"), { cwd: dir });
    expect(record, "the steward's lease was not released").toBeUndefined();
  }, 20_000);
});
