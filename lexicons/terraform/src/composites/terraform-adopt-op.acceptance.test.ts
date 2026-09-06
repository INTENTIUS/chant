/**
 * The acceptance test is choudoufu, not a fixture (#2105): adopt a live
 * resource nothing has marked, end to end.
 *
 * `terraform-adopt-op.test.ts` next door proves the shape chant emits.
 * `choudoufu.test.ts` proves the activities' contract against a stubbed child
 * process. This proves the shape does the thing: create an unmarked VPC
 * directly against choudoufu's pinned emulator, so it is a live resource this
 * estate does not own at an identity this root's configuration declares; run
 * the Ledger step and expect exactly one adoptable match with the two marker
 * values on it; run the Adopt step and let it write them; re-plan and expect
 * the estate to own the same VPC, with nothing left adoptable.
 *
 * The Op's phases are not run through `runOpLocally` here, deliberately.
 * `TerraformAdoptOp` always emits a gate — adoption moves the estate's
 * boundary, and there is no ungated form — and the local executor refuses any
 * Op containing one (`packages/core/src/op/local-executor.ts`). So this drives
 * the two activities the Op's Ledger and Adopt phases are built from, in the
 * same order and with the same hand-off, which is the part a real binary can
 * falsify. `choudoufu.acceptance.test.ts` takes the same approach for the same
 * reason.
 *
 * ## Why this skips today
 *
 * choudoufu#894: `live-plan -json` is reachable only through the `-estate`
 * form, and that form is refused on a configuration that names its own estate
 * ("Estate named by both the live block and -estate"), while the same root
 * without `-estate` refuses with "Machine-readable output is not available
 * under live resource markers yet". The one configuration shape choudoufu's
 * own docs lead with is the one shape the #788 document cannot be produced
 * for, so `choudoufuLivePlan` throws on any real live root until that lands.
 * Found by chant #2104 against a source build at HEAD.
 *
 * The gate below names it, alongside the ordinary two: no binary, and no
 * emulator. When #894 ships, drop `CHOUDOUFU_894_OPEN` and this suite runs as
 * written.
 *
 * Gating copied from `./terraform-apply-op.acceptance.test.ts` (`onPath`),
 * which in turn copies `lexicons/k3s/src/serializer.acceptance.test.ts`'s
 * pattern of skipping with the reason named in the describe title rather than
 * failing when the real dependency is absent.
 */

import { execSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { choudoufuAdopt, choudoufuLivePlan, terraformInit } from "../op/activities/terraform";

function onPath(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * https://github.com/INTENTIUS/choudoufu/issues/894. Flip to `false` when the
 * `-json` document becomes reachable on a root that declares its own estate.
 * chant #2168 tracks this and the other four reversals that unblock together.
 */
const CHOUDOUFU_894_OPEN = true;

const emulatorEndpoint = process.env.CHOUDOUFU_EMULATOR_ENDPOINT;

const skipReason = !onPath("choudoufu")
  ? "no choudoufu binary on PATH"
  : !onPath("aws")
    ? "no aws CLI on PATH (the unmarked resource is created with it, and adopted through it)"
    : !emulatorEndpoint
      ? "CHOUDOUFU_EMULATOR_ENDPOINT is not set (bring up choudoufu's `just smoke` emulator stack and export it)"
      : CHOUDOUFU_894_OPEN
        ? "choudoufu#894: live-plan -json is refused on a configuration that declares its own estate, " +
          "so there is no adoption ledger to act on yet"
        : "";

const FIXTURE = join(import.meta.dirname, "..", "__fixtures__", "live-adopt");
const ESTATE = "chant-adopt-fixture";
const CIDR = "10.77.0.0/16";
const workspaces: string[] = [];

afterAll(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});

/** A fresh copy of the live-adopt fixture, wired up with a real project config. */
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-adopt-accept-"));
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
  `TerraformAdoptOp adopts an unmarked live resource${skipReason ? ` (skipped: ${skipReason})` : ""}`,
  () => {
    it(
      "ledgers one adoptable VPC, writes its two markers, and re-plans with it owned",
      { timeout: 600_000 },
      async () => {
        const dir = project();

        process.env.AWS_ENDPOINT_URL ??= emulatorEndpoint;
        process.env.AWS_ACCESS_KEY_ID ??= "choudoufu-emulator";
        process.env.AWS_SECRET_ACCESS_KEY ??= "choudoufu-emulator";
        process.env.AWS_DEFAULT_REGION ??= "us-east-1";

        // The stock-created resource: a VPC at the cidr this root declares,
        // carrying no ownership marker at all. Nothing about it says which
        // configuration made it, which is exactly the migration situation.
        execSync(
          `aws ec2 create-vpc --cidr-block ${CIDR} --endpoint-url ${emulatorEndpoint} --region us-east-1`,
          { stdio: "pipe" },
        );

        await terraformInit({ root: "estate", cwd: dir });

        const ledger = await choudoufuLivePlan({ root: "estate", cwd: dir, adoptionOnly: true });
        expect(ledger.estate).toBe(ESTATE);
        expect(ledger.contested).toEqual([]);
        expect(ledger.adoptions).toHaveLength(1);
        const [candidate] = ledger.adoptions;
        expect(candidate.addr).toBe("aws_vpc.adoptable");
        expect(candidate.markerEstate).toBe(ESTATE);
        expect(candidate.markerAddress).toBe("aws_vpc.adoptable");
        // A VPC is tagged through `ec2 create-tags`, which choudoufu prints a
        // command for; a candidate with none would be refused below instead.
        expect(candidate.command).toContain("create-tags");
        expect(ledger.ledger).toContain("aws_vpc.adoptable <- aws_vpc vpc-");

        const adopted = await choudoufuAdopt({
          root: "estate",
          cwd: dir,
          adoptions: ledger.adoptions,
          contested: ledger.contested,
        });
        expect(adopted.mechanism).toBe("tag-write");
        expect(adopted.adopted).toEqual(["aws_vpc.adoptable"]);
        expect(adopted.refused).toEqual([]);

        // The markers are the whole ownership answer, so a re-plan binds the
        // same live VPC instead of proposing a second one: nothing is left
        // unowned at this estate's declared identity, and nothing adoptable.
        const after = await choudoufuLivePlan({ root: "estate", cwd: dir });
        expect(after.adoptable).toBe(0);
        expect(after.unowned).toBe(0);
        expect(after.adoptions).toEqual([]);

        // And the estate now says so: the VPC is bound at the declared address.
        const bound = (after.json as { bound?: Array<{ addr?: string; identity?: string }> }).bound ?? [];
        expect(bound.map((b) => b.addr)).toContain("aws_vpc.adoptable");
      },
    );
  },
);
