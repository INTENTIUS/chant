/**
 * The composed run of estates (#4445) against a real choudoufu: three
 * estates (network, app, edge), where app tags a bucket with the id of the
 * subnet network creates in the same apply. One plan, one apply, and the
 * values read after it from a post-apply plan's `prior_state`.
 *
 * Gated on a `choudoufu` of v0.31.0 or later on PATH (choudoufu#2059) and
 * `CHOUDOUFU_EMULATOR_ENDPOINT`, like the other acceptance suites
 * (`../__fixtures__/ACCEPTANCE.md`), and skipped with the reason named
 * otherwise.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { compositionFor } from "../compose";
import type { TerraformConfig } from "../config";
import { isOlderVersion, MIN_CHOUDOUFU_ESTATES_VERSION, parseChoudoufuVersion } from "../op/activities/terraform";
import { runBinary, type BinaryExec } from "../state/exec";
import { EstateRun } from "./estate";

const emulatorEndpoint = process.env.CHOUDOUFU_EMULATOR_ENDPOINT;

function choudoufuVersion(): string | undefined {
  try {
    return parseChoudoufuVersion(execFileSync("choudoufu", ["version"], { encoding: "utf-8" })) ?? "dev";
  } catch {
    return undefined;
  }
}
const version = choudoufuVersion();
const missing =
  version === undefined
    ? "choudoufu is not on PATH"
    : version !== "dev" && isOlderVersion(version, MIN_CHOUDOUFU_ESTATES_VERSION)
      ? `choudoufu ${version} is older than v${MIN_CHOUDOUFU_ESTATES_VERSION}`
      : !emulatorEndpoint
        ? "CHOUDOUFU_EMULATOR_ENDPOINT is not set (bring up choudoufu's `just smoke` emulator stack and export it)"
        : undefined;

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function env(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AWS_ENDPOINT_URL: process.env.AWS_ENDPOINT_URL ?? emulatorEndpoint,
    AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID ?? "choudoufu-emulator",
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? "choudoufu-emulator",
    AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION ?? "us-east-1",
    AWS_REGION: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1",
  };
}

const PROVIDERS = 'terraform {\n  required_providers {\n    aws = {\n      source = "hashicorp/aws"\n    }\n  }\n}\n\nprovider "aws" {\n  region = "us-east-1"\n}\n\n';
const live = (estate: string, body: string): string => `terraform {\n  live {\n    estate = "${estate}"\n  }\n}\n\n${PROVIDERS}${body}`;
const tf = (name: string): DriverComponent => ({ name, deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: name }] }] });

describe.skipIf(missing !== undefined)(`a composed run of three estates against a real choudoufu (#4445)${missing ? `: skipped, ${missing}` : ""}`, () => {
  it("plans all three as one, applies once, and app receives the subnet id network created", async () => {
    const id = `chant-4445-${Date.now().toString(36)}`;
    const dir = mkdtempSync(join(tmpdir(), "chant-compose-estate-e2e-"));
    made.push(dir);
    const files: Record<string, string> = {
      "roots/network/main.tf": live(
        `${id}-network`,
        'resource "aws_vpc" "main" {\n  cidr_block = "10.61.0.0/16"\n}\n\nresource "aws_subnet" "a" {\n  vpc_id     = aws_vpc.main.id\n  cidr_block = "10.61.1.0/24"\n}\n\noutput "subnet_id" {\n  value = aws_subnet.a.id\n}\n',
      ),
      "roots/app/main.tf": live(
        `${id}-app`,
        `data "terraform_estate_outputs" "network" {\n  estate = "${id}-network"\n  names  = ["subnet_id"]\n}\n\nresource "aws_s3_bucket" "app" {\n  bucket = "${id}-app"\n  tags = {\n    subnet = data.terraform_estate_outputs.network.values.subnet_id\n  }\n}\n\noutput "subnet_tag" {\n  value = aws_s3_bucket.app.tags["subnet"]\n}\n`,
      ),
      "roots/edge/main.tf": live(`${id}-edge`, `resource "aws_cloudwatch_log_group" "edge" {\n  name = "/${id}/edge"\n}\n`),
    };
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    const terraform: TerraformConfig = { binary: "choudoufu", roots: { network: { dir: "roots/network" }, app: { dir: "roots/app" }, edge: { dir: "roots/edge" } }, compose: { enabled: true } };
    const composition = compositionFor({ projectRoot: dir, components: [tf("network"), tf("app"), tf("edge")], terraform, env: env() });
    expect(composition.estate).toBe(true);

    const calls: string[][] = [];
    const exec: BinaryExec = (binary, args, at, e, io) => {
      calls.push(args);
      return runBinary(binary, args, at, e, io);
    };
    const run = new EstateRun({ projectRoot: dir, composition, terraform, env: env(), exec });
    try {
      const p = await run.plan();
      expect(p.fallback).toBeUndefined();
      expect(p.error).toBeUndefined();
      expect(p.members.app!.shape.unknownInputs).toEqual(["network.subnet_id"]);
      const a = await run.apply();
      expect(a.error).toBeUndefined();
      expect(a.ok).toBe(true);
      const subnet = a.members.network!.outputs!.subnet_id;
      expect(subnet).toMatch(/^subnet-/);
      expect(a.members.app!.outputs!.subnet_tag).toBe(subnet);
      expect(calls.filter((c) => c[0] === "apply")).toHaveLength(1);
      expect(calls.some((c) => c[0] === "state" || c[0] === "force-unlock")).toBe(false);
      for (const c of calls.filter((x) => x[0] === "show")) expect(c[c.length - 1]).toMatch(/\.tfplan$/);
    } finally {
      await run.release();
    }
  }, 300_000);
});
