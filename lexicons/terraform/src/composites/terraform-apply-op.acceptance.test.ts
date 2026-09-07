/**
 * The acceptance test is terraform, not a fixture (#2086).
 *
 * Everything else in this lexicon's Op suite proves the shape of what chant
 * emits. This proves the shape runs: build a `TerraformApplyOp` with
 * `gate: "never"` (a gate ends a local run as `gated` since #2119, so an
 * acceptance run that must reach Apply declares none), hand
 * it to `runOpLocally` with the activities the registry resolves by
 * convention, and let a real `terraform` — or `tofu` — init, plan and apply
 * the #2083 `with-backend` fixture root into a temp directory. Two
 * `null_resource`s in the resulting state is the pass.
 *
 * The backend is `local`, so no credentials and no remote state are involved.
 * The `hashicorp/null` provider still has to be downloaded from the registry,
 * so the suite needs network as well as a binary. Both are gated, with the
 * reason visible in the runner:
 *
 *   - no `terraform` and no `tofu` on PATH,
 *   - `CHANT_OFFLINE` set, or `registry.terraform.io` not resolvable.
 *
 * Gating copied from `lexicons/k3s/src/serializer.acceptance.test.ts`, which
 * skips the same way when Docker is absent.
 *
 * `../__fixtures__/ACCEPTANCE.md` records what both blocks in this file have
 * last passed against, with the binary version and the date (#2220). Update
 * it in the same change as a run.
 */

import { execSync } from "node:child_process";
import { lookup } from "node:dns/promises";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadActivities, loadProfiles, runOpLocally, type OpConfig } from "@intentius/chant/op";
import { TerraformApplyOp } from "./terraform-apply-op";
import {
  MIN_CHOUDOUFU_VERSION,
  isOlderVersion,
  parseChoudoufuVersion,
  terraformApply,
  terraformInit,
  terraformPlan,
  terraformShow,
} from "../op/activities/terraform";

function onPath(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** The registry has to answer for the provider download; a DNS answer is enough of a probe. */
async function registryResolvable(): Promise<boolean> {
  try {
    await Promise.race([
      lookup("registry.terraform.io"),
      new Promise((_r, reject) => setTimeout(() => reject(new Error("dns timeout")), 3000)),
    ]);
    return true;
  } catch {
    return false;
  }
}

const binary: "terraform" | "tofu" | undefined = onPath("terraform")
  ? "terraform"
  : onPath("tofu")
    ? "tofu"
    : undefined;
const offline = Boolean(process.env.CHANT_OFFLINE);
const online = !offline && binary !== undefined && (await registryResolvable());

const skipReason = !binary
  ? "no terraform or tofu binary on PATH"
  : !online
    ? offline
      ? "CHANT_OFFLINE is set and the provider download needs the registry"
      : "registry.terraform.io is unreachable and the provider download needs it"
    : "";

const FIXTURE = join(import.meta.dirname, "..", "__fixtures__", "with-backend");
const workspaces: string[] = [];

afterAll(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(skipReason !== "")(
  `TerraformApplyOp applies a real root${skipReason ? ` (skipped: ${skipReason})` : ""}`,
  () => {
    it(
      "inits, plans and applies the with-backend fixture, leaving two null_resources in state",
      { timeout: 300_000 },
      async () => {
        const project = mkdtempSync(join(tmpdir(), "chant-tf-accept-"));
        workspaces.push(project);
        cpSync(FIXTURE, join(project, "root"), { recursive: true });
        writeFileSync(
          join(project, "chant.config.json"),
          JSON.stringify(
            { lexicons: ["terraform"], terraform: { binary, roots: { acceptance: { dir: "./root" } } } },
            null,
            2,
          ),
        );

        const { op } = TerraformApplyOp({
          name: "terraform-acceptance",
          root: "acceptance",
          gate: "never",
          cwd: project,
        });

        const activities = await loadActivities(["terraform"]);
        expect([...activities.keys()]).toEqual(
          expect.arrayContaining(["terraformInit", "terraformPlan", "terraformApply", "terraformShow"]),
        );

        const result = await runOpLocally(
          (op as unknown as { props: OpConfig }).props,
          activities,
          await loadProfiles(),
        );

        expect(result.status).toBe("ok");
        expect(result.records.map((r) => `${r.phase}:${r.status}`)).toEqual([
          "Init:ok",
          "Plan:ok",
          "Apply:ok",
        ]);

        // The plan proposed two creates, and said so through the outcome the
        // Plan step surfaces as the `Changed` run outcome.
        const plan = result.records.find((r) => r.phase === "Plan")!;
        expect(plan.outcome).toEqual({ name: "Changed", value: true });

        // What terraform actually left behind.
        const state = await terraformShow({ root: "acceptance", cwd: project });
        const addresses = (
          (state.json as { values?: { root_module?: { resources?: Array<{ address?: string }> } } }).values
            ?.root_module?.resources ?? []
        ).map((r) => r.address);
        expect(addresses.sort()).toEqual(["null_resource.first", "null_resource.second"]);
      },
    );
  },
);

/**
 * `TerraformApplyOp` on a live root, against choudoufu's own pinned emulator
 * (#2106 follow-up). Two suites, gated the same way
 * `../op/activities/choudoufu.acceptance.test.ts` is, plus a version floor:
 *
 *   - no `choudoufu` on PATH,
 *   - a `choudoufu` older than {@link MIN_CHOUDOUFU_VERSION}, which is the
 *     release that shipped the approval artifact
 *     ([choudoufu #878](https://github.com/INTENTIUS/choudoufu/issues/878),
 *     PR 889): before it, `plan -out` was refused under a live block and this
 *     Op could not be built the way it is built now,
 *   - `CHOUDOUFU_EMULATOR_ENDPOINT` unset (bring up choudoufu's `just smoke`
 *     docker compose stack and export `http://localhost:<mapped port>`).
 *
 * The #894 clause the first version of this suite carried is gone. That issue
 * is still open, but it is about `live-plan -json`, which the apply Op no
 * longer runs: the plan half is the stock `plan -out` path. `TerraformWatchOp`
 * and `TerraformAdoptOp` still need the document and still wait on it.
 *
 * The first test is the happy path end to end through `runOpLocally`. The
 * second is the refusal, and it runs the activities directly rather than
 * through the Op, because the world has to move between the Plan step and the
 * Apply step and there is no seam inside a running Op to do that from.
 */

function versionOf(binary: string): string | undefined {
  try {
    return parseChoudoufuVersion(execSync(`${binary} version`, { encoding: "utf8" }));
  } catch {
    return undefined;
  }
}

const LIVE_FIXTURE = join(import.meta.dirname, "..", "__fixtures__", "live");

/** A throwaway project holding a copy of the live fixture as its one root. */
function liveProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-choudoufu-apply-accept-"));
  workspaces.push(dir);
  cpSync(LIVE_FIXTURE, join(dir, "root"), { recursive: true });
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

/** The estate-wide marker sweep configures the AWS provider whatever the root declares. */
function pointAtTheEmulator(endpoint: string): void {
  process.env.AWS_ENDPOINT_URL ??= endpoint;
  process.env.AWS_ACCESS_KEY_ID ??= "choudoufu-emulator";
  process.env.AWS_SECRET_ACCESS_KEY ??= "choudoufu-emulator";
  process.env.AWS_DEFAULT_REGION ??= "us-east-1";
}

const choudoufuVersion = onPath("choudoufu") ? versionOf("choudoufu") : undefined;
const emulatorEndpoint = process.env.CHOUDOUFU_EMULATOR_ENDPOINT;

const liveSkipReason: string = !onPath("choudoufu")
  ? "no choudoufu binary on PATH"
  : choudoufuVersion === undefined
    ? "the choudoufu on PATH reports no release version (a dev build), so the approval artifact cannot be assumed"
    : isOlderVersion(choudoufuVersion, MIN_CHOUDOUFU_VERSION)
      ? `choudoufu ${choudoufuVersion} is older than v${MIN_CHOUDOUFU_VERSION}, which shipped the approval artifact (choudoufu #878)`
      : !emulatorEndpoint
        ? "CHOUDOUFU_EMULATOR_ENDPOINT is not set (bring up choudoufu's `just smoke` emulator stack and export it)"
        : "";

describe.skipIf(liveSkipReason !== "")(
  `TerraformApplyOp applies a live root against choudoufu's emulator${liveSkipReason ? ` (skipped: ${liveSkipReason})` : ""}`,
  () => {
    it(
      'inits, plans to a file, applies that file, gate: "never" — two null_resources applied',
      { timeout: 600_000 },
      async () => {
        pointAtTheEmulator(emulatorEndpoint!);
        const project = liveProject();

        const { op } = TerraformApplyOp({
          name: "choudoufu-acceptance",
          root: "estate",
          gate: "never",
          cwd: project,
        });

        // The plan file is what crosses the (skipped) gate, so the built Op
        // has to name one even here, where nothing waits on it.
        const applyStep = (op as unknown as { props: OpConfig }).props.phases
          .find((p) => p.name === "Apply")!
          .steps[0] as { args?: Record<string, unknown> };
        expect(applyStep.args?.planFile).toBeDefined();

        const activities = await loadActivities(["terraform"]);
        const result = await runOpLocally(
          (op as unknown as { props: OpConfig }).props,
          activities,
          await loadProfiles(),
        );

        expect(result.status).toBe("ok");
        expect(result.records.map((r) => `${r.phase}:${r.status}`)).toEqual(["Init:ok", "Plan:ok", "Apply:ok"]);

        // A live root has no state file to read back: the state cache is not
        // stock's `terraform.tfstate` and `show` over it renders nothing. The
        // estate's own answer is the next plan, which is built from the live
        // system, so what was applied is read back the way choudoufu means it
        // to be. Empty, and its prior state holds exactly the two resources.
        const after = await terraformPlan({ root: "estate", cwd: project });
        expect(after.changed).toBe(false);
        expect({ adds: after.adds, changes: after.changes, destroys: after.destroys }).toEqual({
          adds: 0,
          changes: 0,
          destroys: 0,
        });
        const applied = (
          (after.json as { prior_state?: { values?: { root_module?: { resources?: Array<{ address?: string }> } } } })
            .prior_state?.values?.root_module?.resources ?? []
        ).map((r) => r.address);
        expect(applied.sort()).toEqual(["null_resource.first", "null_resource.second"]);
      },
    );

    it(
      "a plan file the live system has moved past comes back as a named refusal, not a throw",
      { timeout: 600_000 },
      async () => {
        pointAtTheEmulator(emulatorEndpoint!);
        const project = liveProject();
        const mainTf = join(project, "root", "main.tf");
        const original = readFileSync(mainTf, "utf8");

        await terraformInit({ root: "estate", cwd: project });
        const plan = await terraformPlan({ root: "estate", cwd: project });
        expect(plan.changed).toBe(true);
        expect(plan.adds).toBe(2);

        // The configuration moves after the approval: one of the two resources
        // the approver read is gone, so the fresh plan the apply builds has a
        // change the file does not, and the file has one the fresh plan does not.
        writeFileSync(mainTf, original.replace(/resource "null_resource" "second" \{[\s\S]*?\n\}\n/, ""));

        const refusedRun = await terraformApply({ root: "estate", cwd: project, planFile: plan.planFile });
        expect(refusedRun.applied).toBe(false);
        expect(refusedRun.refused).toBe("approval-mismatch");
        expect(refusedRun.refusal).toContain("The approved plan no longer matches the live system");
        expect(refusedRun.refusal).toContain("null_resource.second");

        // The sibling refusal, from the same exit status: the file was produced
        // against another estate than the one this directory now declares.
        writeFileSync(mainTf, original.replace('estate = "fixture-estate"', 'estate = "renamed-estate"'));
        const wrongEstate = await terraformApply({ root: "estate", cwd: project, planFile: plan.planFile });
        expect(wrongEstate.applied).toBe(false);
        expect(wrongEstate.refused).toBe("wrong-estate");
        expect(wrongEstate.refusal).toContain("The approved plan belongs to a different estate");

        // And with the world back where the approval found it, the same file applies.
        writeFileSync(mainTf, original);
        const applied = await terraformApply({ root: "estate", cwd: project, planFile: plan.planFile });
        expect(applied.applied).toBe(true);
        expect(applied.refused).toBeUndefined();
      },
    );
  },
);
