/**
 * The acceptance test is choudoufu, not a fixture (#2103).
 *
 * Everything in `choudoufu.test.ts` proves the shape of the pure command
 * builders and the activities' contract against a stubbed child process.
 * This proves the shape runs against a real `choudoufu` binary: `live-check`
 * against the `__fixtures__/live` root (no cloud calls, so this half needs
 * only the binary), and `live-plan` against choudoufu's own pinned emulator
 * (`live/smoke/README.md`'s `just smoke` docker compose stack in
 * https://github.com/INTENTIUS/choudoufu), and that half makes real AWS SDK
 * calls (the estate-wide marker sweep configures the AWS provider and reads
 * it regardless of which resource types the root declares), so it needs the
 * emulator's endpoint too.
 *
 * Both are gated, with the reason visible in the runner:
 *
 *   - no `choudoufu` on PATH: build it from
 *     https://github.com/INTENTIUS/choudoufu with `go build ./cmd/choudoufu`
 *     and put it on PATH, or download a release binary.
 *   - `CHOUDOUFU_EMULATOR_ENDPOINT` unset: bring up the emulator with
 *     `just smoke` in that checkout (it prints the floci container's mapped
 *     port; `http://localhost:<port>` is this variable's value) and export
 *     it before running this suite.
 *
 * Gating copied from `../../composites/terraform-apply-op.acceptance.test.ts`
 * (`onPath`), which in turn copies `lexicons/k3s/src/serializer.acceptance.
 * test.ts`'s pattern of skipping with the reason named in the describe title
 * rather than failing when the real dependency is absent.
 */

import { execSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { choudoufuLiveCheck, choudoufuLivePlan, terraformInit } from "./terraform";

function onPath(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const hasChoudoufu = onPath("choudoufu");
const emulatorEndpoint = process.env.CHOUDOUFU_EMULATOR_ENDPOINT;

const skipReason = !hasChoudoufu
  ? "no choudoufu binary on PATH"
  : !emulatorEndpoint
    ? "CHOUDOUFU_EMULATOR_ENDPOINT is not set (bring up choudoufu's `just smoke` emulator stack and export it)"
    : "";

const FIXTURE = join(import.meta.dirname, "..", "..", "__fixtures__", "live");
const workspaces: string[] = [];

afterAll(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});

/** A fresh copy of the live fixture, wired up with a real project config. */
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-choudoufu-accept-"));
  workspaces.push(dir);
  cpSync(FIXTURE, join(dir, "root"), { recursive: true });
  writeFileSync(
    join(dir, "chant.config.json"),
    JSON.stringify(
      { lexicons: ["terraform"], terraform: { binary: "choudoufu", roots: { estate: { dir: "./root" } } } },
      null,
      2,
    ),
  );
  return dir;
}

describe.skipIf(skipReason !== "")(
  `choudoufu live-check and live-plan against the fixture${skipReason ? ` (skipped: ${skipReason})` : ""}`,
  () => {
    it(
      "live-check admits the __fixtures__/live root (null_resource, one live block, no cloud calls)",
      { timeout: 60_000 },
      async () => {
        const dir = project();
        const result = await choudoufuLiveCheck({ root: "estate", cwd: dir });
        expect(result.refused).toBe(false);
      },
    );

    it(
      "live-plan reads the emulator and proposes creating both null_resources on a fresh estate",
      { timeout: 300_000 },
      async () => {
        const dir = project();
        const rootDir = join(dir, "root");

        // The estate-wide marker sweep configures the AWS provider and reads
        // it regardless of which resource types the root declares (#2103's
        // ops.mdx and choudoufu's setup.md both name this), so the emulator's
        // endpoint and dummy credentials have to reach the provider even
        // though this fixture's only resource is `null_resource`.
        process.env.AWS_ENDPOINT_URL ??= emulatorEndpoint;
        process.env.AWS_ACCESS_KEY_ID ??= "choudoufu-emulator";
        process.env.AWS_SECRET_ACCESS_KEY ??= "choudoufu-emulator";
        process.env.AWS_DEFAULT_REGION ??= "us-east-1";

        await terraformInit({ root: "estate", cwd: dir });

        const result = await choudoufuLivePlan({ root: "estate", cwd: dir });
        expect(result.estate).toBe("fixture-estate");
        // A fresh estate proposes creating both null_resources: -detailed-
        // exitcode's exit 2 (a plan with changes) is success here, not the
        // no-drift case, since this root has never applied.
        expect(result.drift).toBe(true);
        expect(result.dir).toBe(rootDir);
      },
    );
  },
);
