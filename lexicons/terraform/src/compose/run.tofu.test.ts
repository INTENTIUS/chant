/**
 * The composed run (#4444) on a real binary: three roots of `terraform_data`,
 * B reading the id A creates through `terraform_remote_state` and C reading
 * B. Local state runs on `tofu` (or `terraform`), skipped when neither is on
 * the PATH. The s3 case runs the same roots against floci, skipped without
 * CHANT_FLOCI_ENDPOINT (for example `docker run -d -p 4611:4566 floci/floci`
 * and `CHANT_FLOCI_ENDPOINT=http://localhost:4611`). Nothing downloads a
 * provider or reaches a cloud account.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { compositionFor } from "../compose";
import type { TerraformConfig } from "../config";
import type { StateFile } from "../state/exec";
import { S3Client, sign } from "../state/s3";
import { COMPOSE_DIR } from "./root";
import { ComposedRun } from "./run";

function which(bin: string): boolean {
  try {
    execFileSync(bin, ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const BINARY = which("tofu") ? "tofu" : which("terraform") ? "terraform" : undefined;
const FLOCI = process.env.CHANT_FLOCI_ENDPOINT?.replace(/\/+$/, "");

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});
const tmp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
};

/** How a root's state is kept: its backend block, and the `config` a reader's `terraform_remote_state` gives to read it. */
interface Backend {
  block: (m: string) => string;
  read: (m: string) => string;
}

const LOCAL: Backend = { block: () => "", read: (m) => `backend = "local"\n  config = {\n    path = "../${m}/terraform.tfstate"\n  }` };

function s3Backend(bucket: string, endpoint: string): Backend {
  const cfg = (m: string) =>
    `bucket = "${bucket}"\n    key = "${m}.tfstate"\n    region = "us-east-1"\n    use_lockfile = true\n    use_path_style = true\n    skip_credentials_validation = true\n    skip_requesting_account_id = true\n    skip_metadata_api_check = true\n    endpoints = { s3 = "${endpoint}" }`;
  return {
    block: (m) => `terraform {\n  backend "s3" {\n    ${cfg(m)}\n  }\n}\n\n`,
    read: (m) => `backend = "s3"\n  config = {\n    ${cfg(m)}\n  }`,
  };
}

/** A root reading `up`'s id; with `fail`, its resource's provisioner fails, as a provider error would. */
const reader = (be: Backend, m: string, up: string, fail = false): string =>
  `${be.block(m)}data "terraform_remote_state" "${up}" {\n  ${be.read(up)}\n}\n\nresource "terraform_data" "x" {\n  input = data.terraform_remote_state.${up}.outputs.id\n${
    fail ? '  provisioner "local-exec" {\n    command = "echo injected provider error >&2; exit 1"\n  }\n' : ""
  }}\n\noutput "id" {\n  value = terraform_data.x.id\n}\n`;

const tf = (name: string, dependsOn: string[] = []): DriverComponent => ({ name, dependsOn, deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: name }] }] });

function project(be: Backend, failB = false) {
  const dir = tmp("chant-compose-tofu-");
  const files: Record<string, string> = {
    a: `${be.block("a")}resource "terraform_data" "x" {\n  input = "a"\n}\n\noutput "id" {\n  value = terraform_data.x.id\n}\n`,
    b: reader(be, "b", "a", failB),
    c: reader(be, "c", "b"),
  };
  for (const [m, text] of Object.entries(files)) {
    mkdirSync(join(dir, "roots", m), { recursive: true });
    writeFileSync(join(dir, "roots", m, "main.tf"), text);
  }
  const terraform: TerraformConfig = { binary: "tofu", roots: { a: { dir: "roots/a" }, b: { dir: "roots/b" }, c: { dir: "roots/c" } }, compose: { enabled: true } };
  const c = compositionFor({ projectRoot: dir, terraform, components: [tf("a"), tf("b", ["a"]), tf("c", ["b"])], env: process.env });
  const env = { ...process.env, ...(FLOCI ? { AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test", AWS_REGION: "us-east-1" } : {}) };
  const run = new ComposedRun({ projectRoot: dir, composition: c, terraform, binary: { path: BINARY! }, env, work: tmp("chant-compose-tofu-work-"), lock: true, runId: "tofu-test", retryDelays: [0] });
  return { dir, c, run };
}

const idOf = (s: StateFile): string => (s.resources[0]!.instances![0] as { attributes: { id: string } }).attributes.id;
const inputOf = (s: StateFile): string => (s.resources[0]!.instances![0] as { attributes: { input: string } }).attributes.input;

describe.skipIf(!BINARY)("a composed run on tofu with local state (#4444)", () => {
  const stateOf = (dir: string, m: string): StateFile => JSON.parse(readFileSync(join(dir, "roots", m, "terraform.tfstate"), "utf-8")) as StateFile;

  test("one plan shows B's input known after apply, one digest covers all three, and one apply creates A, B and C with A's id in B", async () => {
    const { dir, c, run } = project(LOCAL);
    expect(c.fallback).toBeUndefined();
    expect(c.order).toEqual(["a", "b", "c"]);
    try {
      const plan = await run.plan();
      expect(plan.error).toBeUndefined();
      expect(plan.unknownReads).toEqual(["b", "c"]);
      expect(plan.members.b!.shape.unknownInputs).toEqual(["a.id"]);
      const change = (plan.members.b!.slice as { resource_changes: { address: string; change: { after_unknown: Record<string, unknown> } }[] }).resource_changes.find((r) => r.address === "terraform_data.x")!;
      expect(change.change.after_unknown.input).toBe(true);
      expect(plan.digest).toMatch(/\S/);
      expect(Object.keys(plan.members)).toEqual(["a", "b", "c"]);

      const applied = await run.apply();
      expect(applied.error).toBeUndefined();
      expect(applied.ok).toBe(true);
      for (const m of ["a", "b", "c"]) expect(applied.members[m]).toMatchObject({ status: "applied", state: "written" });
      const a = stateOf(dir, "a");
      const b = stateOf(dir, "b");
      const cs = stateOf(dir, "c");
      expect(inputOf(b)).toBe(idOf(a));
      expect(inputOf(cs)).toBe(idOf(b));
      expect(applied.members.b!.outputs).toEqual({ id: idOf(b) });
    } finally {
      await run.release();
    }
    expect(existsSync(join(dir, COMPOSE_DIR))).toBe(false);
    expect(["a", "b", "c"].filter((m) => existsSync(join(dir, "roots", m, "terraform.tfstate.tflock")))).toEqual([]);
  });

  test("B failing: A applied and written, B failed with what applied of it written, C not-started", async () => {
    const { dir, run } = project(LOCAL, true);
    try {
      expect((await run.plan()).error).toBeUndefined();
      const applied = await run.apply();
      expect(applied.ok).toBe(false);
      expect(applied.members.a).toMatchObject({ status: "applied", state: "written" });
      expect(applied.members.b).toMatchObject({ status: "failed", state: "written" });
      expect(applied.members.c).toMatchObject({ status: "not-started", state: "unchanged" });
      // B's resource was created and its provisioner failed: its state holds it, tainted, with A's id.
      const b = stateOf(dir, "b");
      expect((b.resources[0]!.instances![0] as { status?: string }).status).toBe("tainted");
      expect(inputOf(b)).toBe(idOf(stateOf(dir, "a")));
      expect(existsSync(join(dir, "roots", "c", "terraform.tfstate"))).toBe(false);
    } finally {
      await run.release();
    }
  });
});

describe.skipIf(!BINARY || !FLOCI)("a composed run on tofu with s3 state on floci (#4444)", () => {
  const bucket = `chant-compose-${process.pid}-${Date.now()}`;
  const creds = { region: "us-east-1", accessKeyId: "test", secretAccessKey: "test" };

  test("one apply creates A, B and C, and each state is written back to its own key with its lock released", async () => {
    const url = `${FLOCI}/${bucket}`;
    const made = await fetch(url, { method: "PUT", headers: sign(creds, "PUT", url, {}, createHash("sha256").update("").digest("hex"), new Date()) });
    expect(made.ok).toBe(true);
    const client = new S3Client({ bucket, endpoint: FLOCI!, ...creds });
    const { run } = project(s3Backend(bucket, FLOCI!));
    try {
      const plan = await run.plan();
      expect(plan.error).toBeUndefined();
      expect(plan.unknownReads).toEqual(["b", "c"]);
      const applied = await run.apply();
      expect(applied.ok).toBe(true);
      const state = async (m: string): Promise<StateFile> => JSON.parse((await client.get(`${m}.tfstate`))!) as StateFile;
      const a = await state("a");
      const b = await state("b");
      expect(inputOf(b)).toBe(idOf(a));
      expect(inputOf(await state("c"))).toBe(idOf(b));
    } finally {
      await run.release();
    }
    for (const m of ["a", "b", "c"]) expect(await client.get(`${m}.tfstate.tflock`)).toBeUndefined();
  });
});
