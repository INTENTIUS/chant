/**
 * The acceptance test is terraform, not a fixture (#2086).
 *
 * Everything else in this lexicon's Op suite proves the shape of what chant
 * emits. This proves the shape runs: build a `TerraformApplyOp` with
 * `gate: "never"` (the local executor refuses any Op containing a gate), hand
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
 */

import { execSync } from "node:child_process";
import { lookup } from "node:dns/promises";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadActivities, loadProfiles, runOpLocally, type OpConfig } from "@intentius/chant/op";
import { TerraformApplyOp } from "./terraform-apply-op";
import { terraformShow } from "../op/activities/terraform";

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

        expect(result.ok).toBe(true);
        expect(result.records.map((r) => `${r.phase}:${r.status}`)).toEqual([
          "Init:ok",
          "Plan:ok",
          "Apply:ok",
        ]);

        // The plan proposed two creates, and said so through the outcome the
        // Plan step surfaces as the `Changed` search attribute.
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
