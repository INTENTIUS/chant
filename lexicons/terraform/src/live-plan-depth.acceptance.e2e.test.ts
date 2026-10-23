/**
 * The plan depth on a live root against a real choudoufu (#4371).
 *
 * Copies `src/__fixtures__/live-estate/` into a temp project under a fresh
 * estate name, so a re-run against the same emulator never meets an earlier
 * run's resources. Setup is what the fixture's README records: apply with
 * `unowned.tf`, `rule.tf` and `adoptable.tf` held back, create the two
 * unowned log groups out of band, then drift two bound resources out of band
 * (a log group's retention, a tag on the VPC) and give the VPC a tag from a
 * `sensitive` variable whose value then changes. `adoptable.tf` stays out:
 * its content match needs a sweep, which an observation read never asks for.
 *
 * Then one `describeResources` at the plan depth, with the real activities.
 *
 * Gated on a `choudoufu` on PATH, an `aws` CLI on PATH and
 * `CHOUDOUFU_EMULATOR_ENDPOINT`, and skipped with the reason named otherwise,
 * like the other acceptance suites (`__fixtures__/ACCEPTANCE.md`). An e2e
 * file: an apply and two reads against the emulator take about a minute.
 */

import { execSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { normalizeObservation } from "@intentius/chant/observation";
import type { Declarable } from "@intentius/chant/declarable";
import { describeResources } from "./describe-resources";
import { renderTerraformRoots } from "./hcl/roots";
import { PLAN_READ_DIR_PREFIX } from "./op/activities/terraform";
import { SENSITIVE_VALUE } from "./plan-observation";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "live-estate");
const emulatorEndpoint = process.env.CHOUDOUFU_EMULATOR_ENDPOINT;

function onPath(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const missing = !onPath("choudoufu")
  ? "choudoufu is not on PATH"
  : !onPath("aws")
    ? "the aws CLI is not on PATH"
    : !emulatorEndpoint
      ? "CHOUDOUFU_EMULATOR_ENDPOINT is not set (bring up choudoufu's `just smoke` emulator stack and export it)"
      : undefined;

const workspaces: string[] = [];
afterAll(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});

function env(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AWS_ENDPOINT_URL: process.env.AWS_ENDPOINT_URL ?? emulatorEndpoint,
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? "choudoufu-emulator",
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? "choudoufu-emulator",
    AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION ?? "us-east-1",
    AWS_REGION: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1",
    TF_IN_AUTOMATION: "1",
  };
}

function run(cmd: string, args: string[], cwd: string): string {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf-8", env: env() });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (exit ${r.status}): ${r.stderr}`);
  return r.stdout;
}

/** Every entry under `dir`, recursively, with its size and mtime: what "nothing new" compares. */
function snapshot(dir: string): string[] {
  return readdirSync(dir, { recursive: true })
    .map(String)
    .sort()
    .map((rel) => {
      const st = statSync(join(dir, rel));
      return `${rel} ${st.isDirectory() ? "dir" : `${st.size} ${st.mtimeMs}`}`;
    });
}

function planDirs(): string[] {
  return readdirSync(tmpdir()).filter((n) => n.startsWith(PLAN_READ_DIR_PREFIX)).sort();
}

describe.skipIf(missing !== undefined)(
  `the plan depth on a live root against a real choudoufu (#4371)${missing ? `: skipped, ${missing}` : ""}`,
  () => {
    it("puts the plan on bound blocks beside live-plan's ownership, redacts the secret, writes nothing in the root", async () => {
      const estate = `chant-4371-${Date.now().toString(36)}`;
      const dir = mkdtempSync(join(tmpdir(), "chant-live-plan-depth-"));
      workspaces.push(dir);
      const root = join(dir, "root");
      cpSync(FIXTURE, root, { recursive: true });
      rmSync(join(root, "README.md"));
      for (const file of readdirSync(root)) {
        const path = join(root, file);
        writeFileSync(path, readFileSync(path, "utf-8").replaceAll("stateless-e2e-block", estate));
      }
      const network = join(root, "network.tf");
      writeFileSync(
        network,
        readFileSync(network, "utf-8").replace(
          'resource "aws_vpc" "main" {\n  cidr_block = "10.99.0.0/16"\n}',
          'resource "aws_vpc" "main" {\n  cidr_block = "10.99.0.0/16"\n  tags       = { token = var.token }\n}',
        ),
      );
      const secret = (value: string) =>
        writeFileSync(join(root, "secret.tf"), `variable "token" {\n  type      = string\n  sensitive = true\n  default   = "${value}"\n}\n`);
      secret(`old-${estate}`);
      writeFileSync(
        join(dir, "chant.config.json"),
        JSON.stringify({ lexicons: ["terraform"], terraform: { binary: "choudoufu", observe: "plan", roots: { estate: { dir: "./root" } } } }),
      );

      // Apply with the three held back, as the fixture's README does.
      const held = join(dir, "held");
      mkdirSync(held);
      for (const f of ["unowned.tf", "rule.tf", "adoptable.tf"]) renameSync(join(root, f), join(held, f));
      run("choudoufu", ["init", "-input=false"], root);
      run("choudoufu", ["apply", "-auto-approve", "-input=false"], root);
      for (const f of ["unowned.tf", "rule.tf"]) renameSync(join(held, f), join(root, f));

      run("aws", ["logs", "create-log-group", "--log-group-name", `/${estate}/adoptable`], root);
      run("aws", ["logs", "create-log-group", "--log-group-name", `/${estate}/held-elsewhere`], root);
      run("aws", ["logs", "tag-log-group", "--log-group-name", `/${estate}/held-elsewhere`, "--tags", "tofu-estate=other-estate,tofu-address=aws_cloudwatch_log_group.elsewhere"], root);
      // Out-of-band drift on two bound resources.
      run("aws", ["logs", "put-retention-policy", "--log-group-name", `/${estate}/app`, "--retention-in-days", "3"], root);
      const vpc = run("aws", ["ec2", "describe-vpcs", "--filters", `Name=tag:tofu-estate,Values=${estate}`, "--query", "Vpcs[0].VpcId", "--output", "text"], root).trim();
      expect(vpc).toMatch(/^vpc-/);
      run("aws", ["ec2", "create-tags", "--resources", vpc, "--tags", "Key=drifted,Value=yes"], root);
      // The live tag now holds the old secret; the configuration declares a new one.
      secret(`new-${estate}`);

      const { entities } = await renderTerraformRoots({ projectRoot: dir, roots: { estate: { dir: "./root" } }, binary: "choudoufu" });
      const map = new Map<string, { entityType: string; props: Record<string, unknown> }>();
      for (const [key, entity] of entities) {
        map.set(key, { entityType: entity.entityType, props: (entity as Declarable & { props: Record<string, unknown> }).props });
      }

      const before = snapshot(root);
      const tempBefore = planDirs();
      const saved = { ...process.env };
      Object.assign(process.env, env());
      let raw;
      try {
        raw = await describeResources({ environment: "prod", buildOutput: "", entityNames: [...map.keys()].sort(), entities: map, cwd: dir });
      } finally {
        process.env = saved;
      }
      const result = normalizeObservation(raw);

      // The read adds nothing to the root: neither the plan file nor the
      // live-plan document (#4379).
      expect(snapshot(root)).toEqual(before);
      expect(planDirs()).toEqual(tempBefore);
      expect(result.notes.join("\n")).toMatch(/estate: the plan read answered \(`choudoufu plan -input=false -lock=false -out=<tmp>\/plan\.tfplan`\)/);
      expect(new Set(Object.values(result.sources))).toEqual(new Set(["live+plan"]));

      const meta = (name: string) => result.resources[`estate/${name}`]!;
      const attrs = (name: string) => meta(name).attributes as Record<string, unknown>;
      expect(meta("aws_vpc.main").ownership).toBe("owned");
      expect(meta("aws_vpc.main").marker).toEqual({ stack: estate });
      expect(attrs("aws_cloudwatch_log_group.app")).toMatchObject({
        planAction: "update",
        planChanges: [{ path: "retention_in_days", before: 3, after: 1 }],
      });
      expect(attrs("aws_vpc.main").planChanges).toEqual(
        expect.arrayContaining([
          { path: "tags.drifted", before: "yes", after: null },
          { path: "tags.token", before: SENSITIVE_VALUE, after: SENSITIVE_VALUE },
        ]),
      );
      expect(attrs("aws_eip.pool").planAction).toBe("no-op");
      expect(attrs("aws_subnet.app").planAction).toBe("no-op");

      expect(meta("aws_cloudwatch_log_group.held_elsewhere").ownership).toBe("foreign");
      expect(attrs("aws_cloudwatch_log_group.held_elsewhere").planAction).toBeUndefined();
      expect(meta("aws_cloudwatch_log_group.adoptable").ownership).toBe("unknown");
      expect(attrs("aws_cloudwatch_log_group.adoptable").planAction).toBeUndefined();
      expect(result.resources["estate/aws_cloudwatch_log_group.never_applied"]).toBeUndefined();

      expect(JSON.stringify(raw)).not.toContain(`old-${estate}`);
      expect(JSON.stringify(raw)).not.toContain(`new-${estate}`);
    }, 600_000);
  },
);
