/**
 * A webhook receiver that runs plain Node imports the verifier from the
 * installed package (#3803). Node does not strip types under node_modules, so
 * the `./notify-verify` and `./notify` exports must reach compiled JS, which
 * the package build keeps in dist/. This packs the package the way a release
 * does, installs the tarball's contents into a scratch project, and imports
 * both entries with `node` and no loader.
 *
 * End to end because `npm pack` runs the package build.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const coreRoot = resolve(import.meta.dirname, "..");

let scratch: string;
let consumer: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "chant-notify-plain-node-"));
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--json", "--pack-destination", scratch], { cwd: coreRoot, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }),
  ) as { filename: string }[];
  execFileSync("tar", ["-xzf", join(scratch, packed[0].filename), "-C", scratch]);
  consumer = join(scratch, "consumer");
  mkdirSync(join(consumer, "node_modules", "@intentius"), { recursive: true });
  symlinkSync(join(scratch, "package"), join(consumer, "node_modules", "@intentius", "chant"), "dir");
}, 300_000);

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

/** Runs `source` as an ES module under plain node in the consumer project, with no loader. */
function plainNode(source: string): string {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  return execFileSync(process.execPath, ["--input-type=module", "-e", source], { cwd: consumer, env, encoding: "utf-8" });
}

describe("the notify entries under plain Node (#3803)", () => {
  test("notify-verify verifies a signed delivery and refuses a tampered one", () => {
    const out = plainNode(`
      const { signWebhook, verifyWebhook } = await import("@intentius/chant/notify-verify");
      const body = JSON.stringify({ schema: "chant.notify/v1" });
      const ts = String(Math.floor(Date.now() / 1000));
      const headers = { "x-chant-signature": signWebhook("key", ts, body), "x-chant-timestamp": ts };
      const good = verifyWebhook({ body, headers, key: "key" });
      const bad = verifyWebhook({ body: body + " ", headers, key: "key" });
      console.log(JSON.stringify({ good: good.ok, bad: bad.ok, from: import.meta.resolve("@intentius/chant/notify-verify") }));
    `);
    const result = JSON.parse(out) as { good: boolean; bad: boolean; from: string };
    expect(result).toMatchObject({ good: true, bad: false });
    expect(result.from).toMatch(/\/dist\/notify-verify\.js$/);
  });

  test("notify loads with the verifier it re-exports", () => {
    const out = plainNode(`
      const notify = await import("@intentius/chant/notify");
      console.log(JSON.stringify({ make: typeof notify.makeNotifyEvent, verify: typeof notify.verifyWebhook }));
    `);
    expect(JSON.parse(out)).toEqual({ make: "function", verify: "function" });
  });
});
