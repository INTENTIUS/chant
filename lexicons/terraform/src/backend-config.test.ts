/**
 * A root can name backend-config files (chant#4459): the config key, the
 * flags init gets, where a relative path resolves, and the keys the
 * composition reads from a file before init.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { terraformRootSchema } from "./config";
import { ROOT_ENTRY_KEYS } from "./lsp/option-keys";
import { backendConfigArgs, backendConfigFileKeys, backendConfigFilePath, readBackendConfigFile } from "./backend-config";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { compositionFor } from "./compose";
import { rootState } from "./compose/hcl";
import { declaredBackend, lockRefusal, readBackend } from "./state/backend";

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-4459-"));
  made.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const S3_NO_LOCK = 'terraform {\n  backend "s3" {\n    bucket = "b"\n  }\n}\n';

describe("terraform.roots.<name>.backendConfigFiles", () => {
  test("the config schema takes a list of paths beside backendConfig, and refuses anything else", () => {
    expect(terraformRootSchema.safeParse({ dir: ".", backendConfigFiles: ["backend.hcl"], backendConfig: { key: "k" } }).success).toBe(true);
    expect(terraformRootSchema.safeParse({ dir: ".", backendConfigFiles: "backend.hcl" }).success).toBe(false);
    expect(terraformRootSchema.safeParse({ dir: ".", backendConfigFiles: [1] }).success).toBe(false);
  });

  test("the LSP offers the key on a root entry", () => {
    expect(ROOT_ENTRY_KEYS.map((k) => k.key)).toContain("backendConfigFiles");
  });

  test("init's flags: files in order, then the pairs", () => {
    expect(backendConfigArgs({ backendConfigFiles: ["a.hcl", "b.hcl"], backendConfig: { key: "k" } })).toEqual(["-backend-config=a.hcl", "-backend-config=b.hcl", "-backend-config=key=k"]);
    expect(backendConfigArgs({})).toEqual([]);
  });
});

describe("a backend-config file's keys", () => {
  test("a relative path resolves against the root's directory, as varFiles does; an absolute one stays", () => {
    expect(backendConfigFilePath("/repo/roots/app", "backend.hcl")).toBe("/repo/roots/app/backend.hcl");
    expect(backendConfigFilePath("/repo/roots/app", "../shared/backend.hcl")).toBe("/repo/roots/shared/backend.hcl");
    expect(backendConfigFilePath("/repo/roots/app", "/etc/backend.hcl")).toBe("/etc/backend.hcl");
  });

  test("a file's key = value lines, typed, comments and interpolations left out", () => {
    const dir = tree({ "backend.hcl": '# shared\nbucket = "acme-state" // the bucket\nuse_lockfile = true\nmax_retries = 5\nkey = "${var.no}"\n' });
    expect(readBackendConfigFile(join(dir, "backend.hcl"))).toEqual({ bucket: "acme-state", use_lockfile: true, max_retries: 5 });
  });

  test("later files over earlier ones, read from the root's directory, and a missing file named", () => {
    const dir = tree({ "roots/app/one.hcl": 'bucket = "one"\nkey = "k"\n', "roots/shared/two.hcl": 'bucket = "two"\n' });
    expect(backendConfigFileKeys(join(dir, "roots/app"), ["one.hcl", "../shared/two.hcl", "gone.hcl"])).toEqual({ config: { bucket: "two", key: "k" }, unread: ["gone.hcl"] });
  });
});

describe("the composition reads the file's keys before init (ruled: yes)", () => {
  test("an s3 root whose use_lockfile = true is only in the file is lockable", () => {
    const dir = tree({ "main.tf": S3_NO_LOCK, "backend.hcl": 'key = "app.tfstate"\nuse_lockfile = true\n' });
    expect(lockRefusal(readBackend(dir, { recorded: null }))).toMatchObject({ refused: "no-lockfile" });
    expect(lockRefusal(readBackend(dir, { recorded: null, backendConfigFiles: ["backend.hcl"] }))).toBeUndefined();
  });

  test("a pair overrides the file, and the file overrides the code", () => {
    const dir = tree({ "main.tf": 'terraform {\n  backend "s3" {\n    bucket = "code"\n    key = "code"\n  }\n}\n', "backend.hcl": 'bucket = "file"\nkey = "file"\n' });
    expect(declaredBackend(dir, { backendConfigFiles: ["backend.hcl"], backendConfig: { key: "pair" } })).toEqual({ type: "s3", config: { bucket: "file", key: "pair" } });
  });

  test("a -backend-config file in TF_CLI_ARGS_init is read too", () => {
    const dir = tree({ "main.tf": S3_NO_LOCK, "ci.hcl": "use_lockfile = true\n" });
    expect(lockRefusal(readBackend(dir, { recorded: null, env: { TF_CLI_ARGS_init: "-backend-config=ci.hcl" } }))).toBeUndefined();
  });

  test("rootState finds the state's address from a key only the file gives", () => {
    const dir = tree({ "main.tf": S3_NO_LOCK });
    expect(rootState(dir, "app", { env: {}, recorded: null, backendConfig: { key: "from-file.tfstate" } }).own).toMatchObject({ key: "from-file.tfstate" });
  });

  test("a composition lines a read up with a member whose state key is only in its file", () => {
    const tf = (name: string): DriverComponent => ({ name, dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: name }] }] });
    const reader = 'data "terraform_remote_state" "a" {\n  backend = "s3"\n  config = {\n    bucket = "b"\n    key    = "a.tfstate"\n  }\n}\n\nresource "terraform_data" "x" {\n  input = data.terraform_remote_state.a.outputs.id\n}\n';
    const lockedS3 = (key?: string): string => `terraform {\n  backend "s3" {\n    bucket = "b"\n${key ? `    key = "${key}"\n` : ""}    use_lockfile = true\n  }\n}\n`;
    const dir = tree({ "roots/a/main.tf": lockedS3(), "roots/a/backend.hcl": 'key = "a.tfstate"\n', "roots/b/main.tf": lockedS3("b.tfstate") + reader });
    const c = compositionFor({
      projectRoot: dir,
      env: {},
      components: [tf("a"), tf("b")],
      terraform: { roots: { a: { dir: "roots/a", backendConfigFiles: ["backend.hcl"] }, b: { dir: "roots/b" } }, compose: { enabled: true } },
    });
    expect(c.reads.get("b")).toEqual([{ via: "remote-state", upstream: "a", name: "a" }]);
  });
});
