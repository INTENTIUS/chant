/**
 * One backend verdict for compose and state (chant#4478). The composition's
 * `backend` fallback (#4438) and the state refusals (#4437) both come from
 * `lockRefusal(readBackend(...))`, so the same root gets the same answer from
 * each, before init (the code and flags) and after (what init recorded,
 * compared with the code).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { compositionFor, type CompositionInput } from "../compose";
import { rootState } from "../compose/hcl";
import type { TerraformConfig } from "../config";
import { LOCKABLE_BACKENDS, LOCKS, cliBackendConfig, declaredBackend, isRefused, lockRefusal, readBackend, stateObject } from "./backend";

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-4478-"));
  made.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const EMPTY = 'resource "terraform_data" "x" {}\n';
const tf = (name: string): DriverComponent => ({ name, dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: name }] }] });
const record = (type: string, config: Record<string, unknown>): string => JSON.stringify({ version: 3, backend: { type, config, hash: 1 } });

/** Credentials for every lockable backend, so a lockable root resolves to a state rather than a credentials refusal. */
const CREDS: NodeJS.ProcessEnv = { AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: "SK", GOOGLE_OAUTH_ACCESS_TOKEN: "t", ARM_ACCESS_KEY: Buffer.from("k").toString("base64") };

interface Case {
  name: string;
  /** Root `c`'s files, beside the plain roots `a` and `b`. */
  files: Record<string, string>;
  env?: NodeJS.ProcessEnv;
  terraform?: Partial<TerraformConfig>;
  /** The refusal kind both sides give, or undefined when chant locks it. */
  refused?: string;
}

const s3 = (body: string): string => `terraform {\n  backend "s3" {\n    bucket = "b"\n    key    = "c.tfstate"\n${body}  }\n}\n`;

const CASES: Case[] = [
  { name: "s3 with use_lockfile = true in the code", files: { "main.tf": s3("    use_lockfile = true\n") } },
  { name: "s3 with no lock file", files: { "main.tf": s3("") }, refused: "no-lockfile" },
  { name: "s3 whose use_lockfile = true reaches init only through TF_CLI_ARGS_init", files: { "main.tf": s3("") }, env: { TF_CLI_ARGS_init: "-input=false -backend-config=use_lockfile=true" } },
  { name: "s3 whose use_lockfile = true is in backendConfig", files: { "main.tf": s3("") }, terraform: { roots: { a: { dir: "roots/a" }, b: { dir: "roots/b" }, c: { dir: "roots/c", backendConfig: { use_lockfile: "true" } } } } },
  { name: "gcs", files: { "main.tf": 'terraform {\n  backend "gcs" {\n    bucket = "b"\n    prefix = "c"\n  }\n}\n' } },
  { name: "azurerm", files: { "main.tf": 'terraform {\n  backend "azurerm" {\n    storage_account_name = "acct"\n    container_name = "tfstate"\n    key = "c.tfstate"\n  }\n}\n' } },
  { name: "local, declared", files: { "main.tf": 'terraform {\n  backend "local" {}\n}\n' } },
  { name: "local, by declaring nothing", files: { "main.tf": EMPTY } },
  { name: "a cloud block", files: { "main.tf": 'terraform {\n  cloud {\n    organization = "o"\n  }\n}\n' }, refused: "cloud" },
  { name: "a cloud block in a .tofu file of a tofu root", files: { "main.tofu": 'terraform {\n  cloud {\n    organization = "o"\n  }\n}\n' }, terraform: { binary: "tofu" }, refused: "cloud" },
  { name: "another backend", files: { "main.tf": 'terraform {\n  backend "consul" {\n    path = "c"\n  }\n}\n' }, refused: "backend" },
  {
    name: "s3 whose use_lockfile = true is only in a backend-config file (chant#4459)",
    files: { "main.tf": s3(""), "backend.hcl": "# the lock\nuse_lockfile = true\n" },
    terraform: { roots: { a: { dir: "roots/a" }, b: { dir: "roots/b" }, c: { dir: "roots/c", backendConfigFiles: ["backend.hcl"] } } },
  },
  {
    name: "init recorded another bucket than the code names",
    files: { "main.tf": s3("    use_lockfile = true\n"), ".terraform/terraform.tfstate": record("s3", { bucket: "elsewhere", key: "c.tfstate", use_lockfile: true }) },
    refused: "disagree",
  },
  {
    name: "init recorded s3 and the code now names gcs",
    files: { "main.tf": 'terraform {\n  backend "gcs" {\n    bucket = "b"\n  }\n}\n', ".terraform/terraform.tfstate": record("s3", { bucket: "b", key: "k", use_lockfile: true }) },
    refused: "disagree",
  },
  {
    name: "init recorded what the code names, plus defaults the code leaves out",
    files: { "main.tf": s3("    use_lockfile = true\n"), ".terraform/terraform.tfstate": record("s3", { bucket: "b", key: "c.tfstate", use_lockfile: true, region: "us-east-1", workspace_key_prefix: null }) },
  },
];

function both(c: Case): { fallback?: string; state: ReturnType<typeof stateObject> } {
  const dir = project({ "roots/a/main.tf": EMPTY, "roots/b/main.tf": EMPTY, ...Object.fromEntries(Object.entries(c.files).map(([f, t]) => [`roots/c/${f}`, t])) });
  const env = { ...CREDS, ...c.env };
  const terraform: TerraformConfig = { roots: { a: { dir: "roots/a" }, b: { dir: "roots/b" }, c: { dir: "roots/c" } }, compose: { enabled: true }, ...c.terraform } as TerraformConfig;
  const input: CompositionInput = { projectRoot: dir, components: [tf("a"), tf("b"), tf("c")], env, terraform };
  const fallback = compositionFor(input).fallbacks.find((f) => f.member === "c" && f.kind === "backend")?.reason;
  const state = stateObject(join(dir, "roots/c"), env, undefined, terraform.binary, {
    ...(terraform.roots.c?.backendConfig ? { backendConfig: terraform.roots.c.backendConfig } : {}),
    ...(terraform.roots.c?.backendConfigFiles ? { backendConfigFiles: terraform.roots.c.backendConfigFiles } : {}),
  });
  return { ...(fallback ? { fallback } : {}), state };
}

describe("compose and state give one verdict per root (chant#4478)", () => {
  for (const c of CASES) {
    test(c.name, () => {
      const { fallback, state } = both(c);
      if (c.refused === undefined) {
        expect(fallback).toBeUndefined();
        expect(isRefused(state)).toBe(false);
        return;
      }
      expect(state).toMatchObject({ refused: c.refused });
      expect(fallback).toBe(`\`c\`: ${isRefused(state) ? state.reason : ""}`);
    });
  }

  test("a disagreement names both sides", () => {
    const { state } = both(CASES.find((c) => c.name.startsWith("init recorded another bucket"))!);
    expect(isRefused(state) && state.reason).toContain('bucket = "b" in the code and flags, bucket = "elsewhere" in what init recorded');
  });

  test("a disagreement over a secret names the key, not its values", () => {
    const dir = project({ "main.tf": 'terraform {\n  backend "s3" {\n    bucket = "b"\n    key = "k"\n    use_lockfile = true\n    secret_key = "one"\n  }\n}\n' });
    const reading = readBackend(dir, { recorded: { type: "s3", config: { bucket: "b", key: "k", use_lockfile: true, secret_key: "two" } } });
    expect(reading.disagreement).toContain("secret_key (value hidden)");
    expect(reading.disagreement).not.toContain("one");
    expect(reading.disagreement).not.toContain("two");
  });
});

describe("the parts of the verdict", () => {
  test("the lockable list is the one LOCKS spells", () => {
    expect(LOCKABLE_BACKENDS).toEqual(["s3", "gcs", "azurerm", "local"]);
    expect(LOCKS).toBe("chant locks and writes s3 (with use_lockfile = true), gcs, azurerm and local states");
    for (const type of LOCKABLE_BACKENDS) expect(lockRefusal({ backend: { type, config: { use_lockfile: true } } })).toBeUndefined();
  });

  test("TF_CLI_ARGS and TF_CLI_ARGS_init -backend-config flags, pairs and files, later over earlier", () => {
    expect(cliBackendConfig({ TF_CLI_ARGS: "-backend-config=region=eu-west-1 -backend-config backend.hcl", TF_CLI_ARGS_init: '-backend-config="region=us-east-2" --backend-config=use_lockfile=true' })).toMatchObject({
      pairs: { region: "us-east-2", use_lockfile: "true" },
      files: ["backend.hcl"],
    });
  });

  test("the declared backend: code, then TF_CLI_ARGS*, then backendConfig", () => {
    const dir = project({ "main.tf": 'terraform {\n  backend "s3" {\n    bucket = "b"\n    key = "k"\n    assume_role {\n      role_arn = "nested"\n    }\n  }\n}\n' });
    expect(declaredBackend(dir, { env: { TF_CLI_ARGS_init: "-backend-config=key=from-env" }, backendConfig: { use_lockfile: "true" } })).toEqual({
      type: "s3",
      config: { bucket: "b", key: "from-env", use_lockfile: true },
    });
  });

  test("the declared backend in Terraform's JSON syntax", () => {
    const dir = project({ "main.tf.json": JSON.stringify({ terraform: { backend: { s3: { bucket: "b", key: "k", use_lockfile: true } } } }) });
    expect(declaredBackend(dir)).toEqual({ type: "s3", config: { bucket: "b", key: "k", use_lockfile: true } });
  });
});

describe("compose's state address comes from the same verdict (chant#4478 round 2)", () => {
  const S3_NO_KEY = 'terraform {\n  backend "s3" {\n    bucket = "b"\n    use_lockfile = true\n  }\n}\n';
  const reader = 'data "terraform_remote_state" "a" {\n  backend = "s3"\n  config = {\n    bucket = "b"\n    key    = "a.tfstate"\n  }\n}\n\nresource "terraform_data" "x" {\n  input = data.terraform_remote_state.a.outputs.id\n}\n';

  test("a key only TF_CLI_ARGS_init gives is the root's state address, as stateObject reads it", () => {
    const dir = project({ "main.tf": S3_NO_KEY });
    const env = { ...CREDS, TF_CLI_ARGS_init: "-backend-config=key=from-init-args.tfstate" };
    expect(rootState(dir, "app", { env, recorded: null }).own).toEqual({ bucket: "b", key: "from-init-args.tfstate" });
    expect(stateObject(dir, env, undefined)).toMatchObject({ backend: "s3", bucket: "b", key: "from-init-args.tfstate" });
    expect(rootState(dir, "app", { env: {}, recorded: null }).own).toBeUndefined();
  });

  test("a key TF_CLI_ARGS gives is overridden by TF_CLI_ARGS_init, as init applies them", () => {
    const dir = project({ "main.tf": S3_NO_KEY });
    const env = { TF_CLI_ARGS: "-backend-config=key=first.tfstate", TF_CLI_ARGS_init: "-backend-config=key=second.tfstate" };
    expect(rootState(dir, "app", { env, recorded: null }).own).toEqual({ bucket: "b", key: "second.tfstate" });
  });

  test("after init, the recorded configuration names the state", () => {
    const dir = project({ "main.tf": S3_NO_KEY, ".terraform/terraform.tfstate": record("s3", { bucket: "b", key: "recorded.tfstate", use_lockfile: true, region: null }) });
    expect(rootState(dir, "app", { env: {} }).own).toEqual({ bucket: "b", key: "recorded.tfstate" });
  });

  test("a composition lines a read up with a member whose key comes only from TF_CLI_ARGS_init", () => {
    const dir = project({ "roots/a/main.tf": S3_NO_KEY, "roots/b/main.tf": S3_NO_KEY + reader });
    const c = compositionFor({
      projectRoot: dir,
      env: { TF_CLI_ARGS_init: "-backend-config=key=a.tfstate" },
      components: [tf("a"), tf("b")],
      terraform: { roots: { a: { dir: "roots/a" }, b: { dir: "roots/b" } }, compose: { enabled: true } },
    });
    expect(c.reads.get("b")).toEqual([{ via: "remote-state", upstream: "a", name: "a" }]);
  });
});
