/**
 * The acceptance test is choudoufu, not a fixture (#2105): adopt a live
 * resource nothing has marked, end to end.
 *
 * `terraform-adopt-op.test.ts` next door proves the shape chant emits.
 * `choudoufu.test.ts` proves the activities' contract against a stubbed child
 * process. This proves the shape does the thing: create an unmarked VPC
 * directly against choudoufu's pinned emulator at the cidr this root declares,
 * so it is a live resource this estate does not own and the sweep can match to
 * a declaration by content; run the Ledger step and expect exactly one
 * adoptable match with the two marker values on it; run the Adopt step and let
 * it write them; re-plan and expect the estate to own the same VPC, with
 * nothing left adoptable.
 *
 * The Op's phases are not run through `runOpLocally` here, deliberately.
 * `TerraformAdoptOp` always emits a gate — adoption moves the estate's
 * boundary, and there is no ungated form — so a local run would stop at the
 * gate and record a pending fact rather than reach the Adopt phase
 * (`packages/core/src/op/gate.ts`). So this drives the two activities the Op's
 * Ledger and Adopt phases are built from, in the same order and with the same
 * hand-off, which is the part a real binary can falsify. `choudoufu.acceptance.test.ts` takes the same approach for the same
 * reason.
 *
 * ## What this suite needed, and when it arrived
 *
 * It had never passed on any binary until choudoufu v0.15.0.
 *
 * The document's `unowned[]` is the resources found at an identity the
 * configuration itself declares. An `aws_cloudwatch_log_group` has one (its
 * name is in the block), so an unmarked live one comes back there with
 * `adopt_tofu_estate`/`adopt_tofu_address` on it. An `aws_vpc` has none: EC2
 * assigns the id, so the document reports `omissions[].reason =
 * "NEEDS_DISCOVERY"` and `unowned[]` stays empty. The live VPC is matched
 * instead by choudoufu's content matcher during the estate-wide sweep, and
 * until v0.15.0 that match was printed only in the human `-adoption-only`
 * render, which choudoufu refuses alongside `-json`. chant #2168 ran this
 * block against v0.14.0 on 2026-09-07, reached the document and stopped, with
 * `ledger.adoptions` empty, and filed
 * [choudoufu #962](https://github.com/INTENTIUS/choudoufu/issues/962).
 *
 * choudoufu PR 963 answered it: the document now carries the match as an
 * `adoptable[]` section, with `swept[]` beside it, and each row carries the
 * two marker values, the arguments the match rested on, and the tagging
 * command. `choudoufuLivePlan` puts `TOFU_LIVE_COLLECT_UNCLAIMED=1` on the
 * `-json` run under `adoptionOnly` so the section is populated at all
 * (choudoufu's `-json` run asks no sweep of its own), and
 * `readAdoptionLedger` reads both sections. Which is what this suite exists
 * to falsify, so the gate that named #962 is gone and only the three ordinary
 * dependencies remain.
 *
 * The fixture stays an `aws_vpc` deliberately. A log group would make the
 * block pass off `unowned[]` alone and would stop it proving the
 * content-matcher path, which is the only thing it exists to prove.
 *
 * The gate below is those three: a `choudoufu`, an `aws` CLI, and the
 * emulator's endpoint.
 *
 * Gating copied from `./terraform-apply-op.acceptance.test.ts` (`onPath`),
 * which in turn copies `lexicons/k3s/src/serializer.acceptance.test.ts`'s
 * pattern of skipping with the reason named in the describe title rather than
 * failing when the real dependency is absent.
 *
 * `../__fixtures__/ACCEPTANCE.md` records what this block has last passed
 * against, and the whole history of why it could not before.
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

const emulatorEndpoint = process.env.CHOUDOUFU_EMULATOR_ENDPOINT;

const skipReason = !onPath("choudoufu")
  ? "no choudoufu binary on PATH"
  : !onPath("aws")
    ? "no aws CLI on PATH (the unmarked resource is created with it, and adopted through it)"
    : !emulatorEndpoint
      ? "CHOUDOUFU_EMULATOR_ENDPOINT is not set (bring up choudoufu's `just smoke` emulator stack and export it)"
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
