/**
 * Where a root's state is (#4437). Carried over from terragucci at c493e0e:
 * test/state-versions.test.ts "where a root's state is" and
 * test/state-stores.test.ts "where a gcs or azurerm root's state is", with
 * the refusals chant adds (no lock file, a cloud block, any other backend).
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { initialisedBackend, isRefused, s3StateKey, stateLocation, stateObject, workspaceOf } from "./backend";

const tmp = (): string => mkdtempSync(join(tmpdir(), "chant-state-"));
const write = (dir: string, files: Record<string, string>): string => {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  return dir;
};
/** A root whose `.terraform` records `type` and `config`, as init leaves it. */
const initialised = (type: string, config: Record<string, unknown>, files: Record<string, string> = {}): string =>
  write(tmp(), { ".terraform/terraform.tfstate": JSON.stringify({ version: 3, backend: { type, config, hash: 1 } }), ...files });

const ENV = { AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: "SK", AWS_REGION: "us-east-1" };
const S3_CONFIG = { bucket: "acme-state", key: "envs/dev/platform.tfstate", region: "eu-west-1", use_lockfile: true, endpoints: { s3: "http://floci:4566", dynamodb: null }, access_key: null, workspace_key_prefix: null };
const GCS = { bucket: "acme-state", prefix: "envs/dev/app", storage_custom_endpoint: "http://gcs.test/storage/v1/", access_token: "backend-token" };
const AZ = { storage_account_name: "acme", container_name: "tfstate", key: "app.tfstate", access_key: Buffer.from("key").toString("base64") };

describe("where an s3 or local root's state is", () => {
  it("reads the backend init recorded, s3 with its bucket, key, region and endpoint", () => {
    const dir = initialised("s3", S3_CONFIG);
    expect(initialisedBackend(dir)?.type).toBe("s3");
    const o = stateObject(dir, ENV);
    expect(o).toMatchObject({ backend: "s3", bucket: "acme-state", key: "envs/dev/platform.tfstate", region: "eu-west-1", endpoint: "http://floci:4566", lockfile: true });
    expect(stateLocation(o)).toBe("s3://acme-state/envs/dev/platform.tfstate");
  });

  it("takes the endpoint from AWS_ENDPOINT_URL when the backend names none, and the key of another workspace", () => {
    const dir = initialised("s3", { ...S3_CONFIG, endpoints: null, workspace_key_prefix: "ws" });
    expect(stateObject(dir, { ...ENV, AWS_ENDPOINT_URL: "http://floci:4566/", TF_WORKSPACE: "blue" })).toMatchObject({ endpoint: "http://floci:4566", key: "ws/blue/envs/dev/platform.tfstate" });
    expect(s3StateKey("k", "default")).toBe("k");
    expect(s3StateKey("k", "green")).toBe("env:/green/k");
  });

  it("reads the workspace select recorded, and TF_DATA_DIR in place of .terraform", () => {
    const dir = write(tmp(), { "data/terraform.tfstate": JSON.stringify({ backend: { type: "s3", config: S3_CONFIG } }), "data/environment": "green\n" });
    expect(workspaceOf(dir, { TF_DATA_DIR: "data" })).toBe("green");
    expect(stateObject(dir, { ...ENV, TF_DATA_DIR: "data" })).toMatchObject({ key: "env:/green/envs/dev/platform.tfstate" });
  });

  it("signs with the backend's own static keys when its configuration names them", () => {
    const o = stateObject(initialised("s3", { ...S3_CONFIG, access_key: "BACKENDKEY", secret_key: "s" }), ENV);
    expect(o).toMatchObject({ target: { accessKeyId: "BACKENDKEY", secretAccessKey: "s" } });
  });

  it("is a local file when init recorded no backend or a local one", () => {
    expect(stateObject(tmp(), ENV)).toEqual({ backend: "local", path: "terraform.tfstate" });
    expect(stateObject(initialised("local", { path: "state/x.tfstate" }), ENV)).toEqual({ backend: "local", path: "state/x.tfstate" });
    expect(stateObject(initialised("local", {}), { TF_WORKSPACE: "blue" })).toEqual({ backend: "local", path: join("terraform.tfstate.d", "blue", "terraform.tfstate") });
  });
});

describe("where a gcs or azurerm root's state is", () => {
  it("names a gcs state <prefix>/<workspace>.tfstate, its lock beside it, with the backend's own credentials first", () => {
    expect(stateObject(initialised("gcs", GCS), { GOOGLE_APPLICATION_CREDENTIALS: "/job/creds.json" })).toMatchObject({ backend: "gcs", bucket: "acme-state", key: "envs/dev/app/default.tfstate", lock: "envs/dev/app/default.tflock", target: { endpoint: "http://gcs.test", accessToken: "backend-token" } });
    expect(stateObject(initialised("gcs", { bucket: "b", prefix: "p/" }), { TF_WORKSPACE: "blue", GOOGLE_APPLICATION_CREDENTIALS: "/job/creds.json" })).toMatchObject({ key: "p/blue.tfstate", lock: "p/blue.tflock", target: { endpoint: "https://storage.googleapis.com", credentialsFile: "/job/creds.json" } });
    expect(stateObject(initialised("gcs", { bucket: "b" }), { GOOGLE_CREDENTIALS: '{"type":"service_account"}' })).toMatchObject({ key: "default.tfstate", target: { credentialsJson: '{"type":"service_account"}' } });
    expect(stateObject(initialised("gcs", { bucket: "b", impersonate_service_account: "sa@p.iam.gserviceaccount.com" }), { GOOGLE_OAUTH_ACCESS_TOKEN: "t" })).toMatchObject({ target: { accessToken: "t", impersonate: "sa@p.iam.gserviceaccount.com" } });
    expect(stateObject(initialised("gcs", { bucket: "b" }), {})).toMatchObject({ backend: "gcs", refused: "credentials" });
  });

  it("names an azurerm blob by its key, <key>env:<workspace> in another workspace, at the cloud's endpoint, with the key, a SAS or the job's OIDC identity", () => {
    expect(stateObject(initialised("azurerm", AZ), {})).toMatchObject({ backend: "azurerm", account: "acme", container: "tfstate", key: "app.tfstate", endpoint: "https://acme.blob.core.windows.net", auth: { accountKey: AZ.access_key } });
    expect(stateObject(initialised("azurerm", { ...AZ, access_key: null, environment: "usgovernment" }), { TF_WORKSPACE: "blue", ARM_SAS_TOKEN: "sv=x&sig=y" })).toMatchObject({ key: "app.tfstateenv:blue", endpoint: "https://acme.blob.core.usgovcloudapi.net", auth: { sas: "sv=x&sig=y" } });
    const oidc = { ARM_TENANT_ID: "tenant", ARM_CLIENT_ID: "client", ARM_OIDC_TOKEN_FILE_PATH: "/t" };
    expect(stateObject(initialised("azurerm", { ...AZ, access_key: null, snapshot: true }), oidc)).toMatchObject({ snapshot: true, auth: { oidc: { tenantId: "tenant", clientId: "client", tokenFile: "/t", authority: "https://login.microsoftonline.com" } } });
    expect(stateObject(initialised("azurerm", { ...AZ, access_key: null }), {})).toMatchObject({ refused: "credentials" });
    expect(stateObject(initialised("azurerm", { key: "k" }), {})).toMatchObject({ refused: "config", reason: expect.stringContaining("storage_account_name, container_name or key") });
  });
});

describe("a state chant does not lock", () => {
  it("is an s3 backend without use_lockfile, named as such", () => {
    for (const use_lockfile of [undefined, false]) {
      const o = stateObject(initialised("s3", { ...S3_CONFIG, use_lockfile }), ENV);
      expect(o).toMatchObject({ backend: "s3", refused: "no-lockfile", reason: expect.stringContaining("use_lockfile = true is unset") });
      expect(stateLocation(o)).toBeUndefined();
    }
  });

  it("is a root with a cloud block, in .tf or .tf.json code, or one init recorded as cloud", () => {
    const hcl = write(tmp(), { "main.tf": 'terraform {\n  cloud {\n    organization = "acme"\n  }\n}\n' });
    expect(stateObject(hcl, ENV)).toMatchObject({ refused: "cloud", reason: expect.stringContaining("cloud block") });
    const json = write(tmp(), { "cdk.tf.json": JSON.stringify({ terraform: [{ required_version: ">= 1.10" }, { cloud: { organization: "acme" } }] }) });
    expect(stateObject(json, ENV)).toMatchObject({ refused: "cloud" });
    expect(stateObject(initialised("cloud", { organization: "acme" }), ENV)).toMatchObject({ backend: "cloud", refused: "cloud" });
    // A cloud block wins over the backend init recorded before it was added.
    expect(stateObject(initialised("s3", S3_CONFIG, { "main.tf": "terraform {\n  cloud {}\n}\n" }), ENV)).toMatchObject({ refused: "cloud" });
  });

  it("is any other backend, named by its type", () => {
    for (const type of ["pg", "kubernetes", "consul", "http", "remote", "cos"]) {
      const o = stateObject(initialised(type, {}), ENV);
      expect(isRefused(o)).toBe(true);
      expect(o).toMatchObject({ backend: type, refused: "backend", reason: expect.stringContaining(`backend is ${type}`) });
    }
  });

  it("is an s3 backend without its bucket or key, or without credentials", () => {
    expect(stateObject(initialised("s3", { ...S3_CONFIG, key: null }), ENV)).toMatchObject({ refused: "config" });
    expect(stateObject(initialised("s3", S3_CONFIG), {})).toMatchObject({ refused: "credentials", reason: expect.stringContaining("s3://acme-state") });
  });
});

describe("the state module", () => {
  it("is plain lexicon code: nothing in it imports from @intentius/chant/components", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const sources = readdirSync(here).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(sources.length).toBeGreaterThan(5);
    for (const f of sources) expect(readFileSync(join(here, f), "utf-8"), f).not.toMatch(/@intentius\/chant\/components/);
  });
});
