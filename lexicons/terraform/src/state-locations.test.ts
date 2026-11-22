/**
 * Where a root's state lives (#5456): the backend block with the backend-config
 * over it, per root and environment. Fixtures are written to a temp project;
 * nothing is run and no bucket is called.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";
import { backendLocation, terraformStateLocations } from "./state-locations";

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "chant-state-locations-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

const S3 = 'terraform {\n  backend "s3" {\n    bucket = "acme-tfstate"\n    key = "network/terraform.tfstate"\n    region = "eu-west-1"\n    dynamodb_table = "acme-tflock"\n  }\n}\n';

describe("terraformStateLocations", () => {
  test("an s3 backend: bucket, key and region, locked by its DynamoDB table", () => {
    const dir = project({ "network/main.tf": S3 });
    expect(terraformStateLocations(dir, { network: { dir: "network" } }, { env: {} })).toEqual([
      {
        environment: null,
        unit: "network",
        substrate: "terraform",
        backend: { kind: "s3", location: { bucket: "acme-tfstate", key: "network/terraform.tfstate", region: "eu-west-1" } },
        lock: { mechanism: "dynamodb", location: { table: "acme-tflock" } },
        reach: { status: "unchecked", reason: expect.stringContaining("configuration") },
      },
    ]);
  });

  test("a workspace is the environment, and an s3 key is the one the backend uses for it", () => {
    const dir = project({ "network/main.tf": S3 });
    const [prod] = terraformStateLocations(dir, { network: { dir: "network", workspace: "prod" } }, { env: {} });
    expect(prod!.environment).toBe("prod");
    expect(prod!.backend.location.key).toBe("env:/prod/network/terraform.tfstate");
  });

  test("a -backend-config pair is applied over the block, and use_lockfile locks beside the state", () => {
    const dir = project({ "app/main.tf": 'terraform {\n  backend "s3" {\n    key = "app.tfstate"\n    use_lockfile = true\n  }\n}\n' });
    const [loc] = terraformStateLocations(dir, { app: { dir: "app", backendConfig: { bucket: "late-bucket", region: "us-east-2" } } }, { env: {} });
    expect(loc!.backend.location).toEqual({ bucket: "late-bucket", key: "app.tfstate", region: "us-east-2" });
    expect(loc!.lock).toEqual({ mechanism: "s3-lockfile", location: { key: "app.tfstate.tflock" } });
  });

  test("a backend-config file supplies the keys a block leaves out", () => {
    const dir = project({
      "app/main.tf": 'terraform {\n  backend "gcs" {}\n}\n',
      "app/prod.gcs.tfbackend": 'bucket = "acme-gcs-state"\nprefix = "app"\n',
    });
    const [loc] = terraformStateLocations(dir, { app: { dir: "app", backendConfigFiles: ["prod.gcs.tfbackend"] } }, { env: {} });
    expect(loc!.backend).toEqual({ kind: "gcs", location: { bucket: "acme-gcs-state", prefix: "app" } });
    expect(loc!.lock).toEqual({ mechanism: "gcs-object" });
  });

  test("a root with no backend block keeps its state in a local file, locked locally", () => {
    const dir = project({ "app/main.tf": 'resource "null_resource" "x" {}\n' });
    const [loc] = terraformStateLocations(dir, { app: { dir: "app" } }, { env: {} });
    expect(loc!.backend).toEqual({ kind: "local", location: { path: "terraform.tfstate" } });
    expect(loc!.lock).toEqual({ mechanism: "local-file" });
  });

  test("a choudoufu live block adds its record store under the estate as the environment", () => {
    const dir = project({
      "live/main.tf":
        S3 + 'terraform {\n  live {\n    estate = "prod"\n    record_store "s3" {\n      bucket = "acme-records"\n      region = "eu-west-1"\n    }\n  }\n}\n',
    });
    const locs = terraformStateLocations(dir, { live: { dir: "live", estate: "prod" } }, { env: {} });
    expect(locs.map((l) => [l.environment, l.unit, l.backend.kind])).toEqual([
      ["prod", "live", "s3"],
      ["prod", "live (records)", "choudoufu-record-store:s3"],
    ]);
    expect(locs[1]!.backend.location).toEqual({ bucket: "acme-records", prefix: "tofu-records/prod/", region: "eu-west-1" });
  });

  test("roots come out in name order", () => {
    const dir = project({ "b/main.tf": S3, "a/main.tf": S3 });
    expect(terraformStateLocations(dir, { b: { dir: "b" }, a: { dir: "a" } }, { env: {} }).map((l) => l.unit)).toEqual(["a", "b"]);
  });
});

describe("backendLocation", () => {
  test("an azurerm backend is locked by a blob lease", () => {
    const { backend, lock } = backendLocation("azurerm", { storage_account_name: "acmestate", container_name: "tfstate", key: "net.tfstate", access_key: "hunter2" }, undefined);
    expect(backend).toEqual({ kind: "azurerm", location: { storage_account_name: "acmestate", container_name: "tfstate", key: "net.tfstate", resource_group_name: null } });
    expect(lock).toEqual({ mechanism: "blob-lease" });
  });

  test("a backend chant has no reading for keeps its type and the keys it names", () => {
    const { backend, lock } = backendLocation("consul", { address: "consul.acme.test:8500", path: "tf/net" }, undefined);
    expect(backend).toEqual({ kind: "consul", location: { address: "consul.acme.test:8500", path: "tf/net" } });
    expect(lock).toBeNull();
  });
});
