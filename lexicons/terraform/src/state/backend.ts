/**
 * Where an initialised root's state is, read from the backend the binary
 * initialised: `<root>/.terraform/terraform.tfstate` (or
 * `$TF_DATA_DIR/terraform.tfstate`), which `init` writes with the backend's
 * type and its whole configuration, whether the root's code, a
 * `-backend-config` file or the job's flags supplied it. Nothing here reads
 * a state's contents.
 *
 * chant locks and writes four backends: s3 with `use_lockfile`, gcs, azurerm
 * and local. Every other backend, and a root with a `cloud` block, comes back
 * as a {@link StateRefusal} naming why, and is never locked.
 *
 * Lifted from terragucci's `backend.ts` (c493e0e): `initialisedBackend`,
 * `dataDir`, `workspaceOf`, `s3StateKey`, `stateObject`, `isStored`,
 * `stateLocation`, and the cloud block check of `migrate.ts`'s `refusal`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { AZURE_AUTHORITY, type AzureOidc } from "./azure-blob";
import { GCS_ENDPOINT, type GcsTarget } from "./gcs";
import { s3FromEnv, type S3Target } from "./s3";

/** The backend `init` recorded: its type and configuration. */
export interface InitialisedBackend {
  type: string;
  config: Record<string, unknown>;
}

/** A state in an S3 bucket. */
export interface S3State {
  backend: "s3";
  bucket: string;
  key: string;
  region: string;
  endpoint?: string;
  /** `use_lockfile = true`: the backend locks with `<key>.tflock` beside the state. */
  lockfile: boolean;
  target: S3Target;
}

/** A state in a GCS bucket: `<prefix>/<workspace>.tfstate`, locked by `<prefix>/<workspace>.tflock`. */
export interface GcsState {
  backend: "gcs";
  bucket: string;
  key: string;
  lock: string;
  target: GcsTarget;
}

/** How a request to Azure Blob Storage is authorized: an account key, a SAS, or the job's OIDC identity. */
export type AzureAuth = { accountKey: string } | { sas: string } | { oidc: AzureOidc };

/** A state blob in an Azure storage container, locked by a lease on it. */
export interface AzureState {
  backend: "azurerm";
  account: string;
  container: string;
  key: string;
  /** The backend snapshots the blob before each write (`snapshot = true`). */
  snapshot: boolean;
  /** The account's blob endpoint. */
  endpoint: string;
  auth: AzureAuth;
}

/** A local state file, its path relative to the root (or absolute). */
export interface LocalState {
  backend: "local";
  path: string;
}

/** Why chant does not lock or write a root's state. */
export type StateRefusalKind = "cloud" | "no-lockfile" | "backend" | "config" | "credentials";

export interface StateRefusal {
  backend: string;
  refused: StateRefusalKind;
  reason: string;
}

/** Where a root's state lives, or why chant does not lock it. */
export type StateObject = S3State | GcsState | AzureState | LocalState | StateRefusal;

/** A state in a bucket or a container. */
export type StoredState = S3State | GcsState | AzureState;

/** A state chant locks and writes. */
export type LockableState = StoredState | LocalState;

export const isRefused = (o: StateObject): o is StateRefusal => "refused" in o;

/** Whether the state is in a bucket or a container: s3, gcs or azurerm. */
export const isStored = (o: StateObject): o is StoredState => !isRefused(o) && o.backend !== "local";

/** What a refusal says chant locks. */
export const LOCKS = "chant locks and writes s3 (with use_lockfile = true), gcs, azurerm and local states";

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** The root's data dir: `TF_DATA_DIR` (relative to the root, as the binary run with `-chdir` reads it), else `.terraform`. */
export function dataDir(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  const d = env.TF_DATA_DIR;
  if (!d) return join(dir, ".terraform");
  return isAbsolute(d) ? d : join(dir, d);
}

/** The backend `init` recorded for the root, or undefined when it has not been initialised with one. */
export function initialisedBackend(dir: string, env: NodeJS.ProcessEnv = process.env): InitialisedBackend | undefined {
  const file = join(dataDir(dir, env), "terraform.tfstate");
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as { backend?: { type?: unknown; config?: unknown } };
    const type = str(parsed.backend?.type);
    if (!type) return undefined;
    const config = parsed.backend?.config && typeof parsed.backend.config === "object" ? (parsed.backend.config as Record<string, unknown>) : {};
    return { type, config };
  } catch {
    return undefined;
  }
}

/** The workspace the binary runs in: `TF_WORKSPACE`, else the one `workspace select` recorded, else `default`. */
export function workspaceOf(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.TF_WORKSPACE) return env.TF_WORKSPACE;
  const file = join(dataDir(dir, env), "environment");
  if (existsSync(file)) {
    const ws = readFileSync(file, "utf-8").trim();
    if (ws) return ws;
  }
  return "default";
}

/** The S3 key of a workspace's state, as the S3 backend names it: the key in `default`, else `<workspace_key_prefix>/<workspace>/<key>`. */
export function s3StateKey(key: string, workspace: string, prefix = "env:"): string {
  return workspace === "default" ? key : `${prefix}/${workspace}/${key}`;
}

/** Whether a root's JSON code gives a `terraform` block a `cloud` block, as `terraform.cloud` or a list of terraform blocks. */
function jsonCloud(doc: unknown): boolean {
  const tf = doc && typeof doc === "object" ? (doc as Record<string, unknown>).terraform : undefined;
  const blocks = Array.isArray(tf) ? tf : tf ? [tf] : [];
  return blocks.some((b) => b && typeof b === "object" && "cloud" in (b as object));
}

/** Whether the root's code (`.tf` or `.tf.json`) has a `cloud` block. */
export function hasCloudBlock(dir: string): boolean {
  if (!existsSync(dir)) return false;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".tf") && !f.endsWith(".tf.json")) continue;
    let text: string;
    try {
      text = readFileSync(join(dir, f), "utf-8");
    } catch {
      continue;
    }
    if (f.endsWith(".tf")) {
      if (/^\s*cloud\s*\{/m.test(text)) return true;
      continue;
    }
    try {
      if (jsonCloud(JSON.parse(text))) return true;
    } catch {
      // Not JSON: the binary reports it.
    }
  }
  return false;
}

const CLOUD_REASON = "the root has a cloud block, whose state HCP Terraform keeps and locks";

/**
 * Where the root's state is, from the backend `init` recorded, or why chant
 * does not lock it. No backend recorded reads as a local one. `backend`
 * stands in for the one `init` recorded.
 */
export function stateObject(dir: string, env: NodeJS.ProcessEnv = process.env, backend: InitialisedBackend | undefined = initialisedBackend(dir, env)): StateObject {
  if (backend?.type === "cloud" || hasCloudBlock(dir)) return { backend: backend?.type ?? "cloud", refused: "cloud", reason: `${CLOUD_REASON}; ${LOCKS}` };
  const ws = workspaceOf(dir, env);
  if (!backend || backend.type === "local") {
    const c = backend?.config ?? {};
    const path = ws === "default" ? (str(c.path) ?? "terraform.tfstate") : join(str(c.workspace_dir) ?? "terraform.tfstate.d", ws, "terraform.tfstate");
    return { backend: "local", path };
  }
  if (backend.type === "gcs") return gcsObject(backend.config, ws, env);
  if (backend.type === "azurerm") return azureObject(backend.config, ws, env);
  if (backend.type !== "s3") return { backend: backend.type, refused: "backend", reason: `the root's backend is ${backend.type}; ${LOCKS}` };
  const c = backend.config;
  const bucket = str(c.bucket);
  const key = str(c.key);
  if (!bucket || !key) return { backend: "s3", refused: "config", reason: "the s3 backend's bucket or key is not in the configuration init recorded" };
  if (c.use_lockfile !== true) return { backend: "s3", refused: "no-lockfile", reason: `the s3 backend takes no lock file (use_lockfile = true is unset), so chant cannot hold its lock; ${LOCKS}` };
  const endpoints = c.endpoints && typeof c.endpoints === "object" ? (c.endpoints as Record<string, unknown>) : {};
  const endpoint = str(endpoints.s3) ?? str(c.endpoint) ?? env.AWS_ENDPOINT_URL_S3 ?? env.AWS_ENDPOINT_URL;
  const region = str(c.region) ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "us-east-1";
  const access = str(c.access_key);
  const secret = str(c.secret_key);
  const jobEnv = { ...env, AWS_REGION: region, ...(access && secret ? { AWS_ACCESS_KEY_ID: access, AWS_SECRET_ACCESS_KEY: secret, AWS_SESSION_TOKEN: str(c.token) ?? "" } : {}) };
  let target: S3Target;
  try {
    target = s3FromEnv({ bucket, ...(endpoint ? { endpoint } : {}) }, jobEnv);
  } catch (e) {
    return { backend: "s3", refused: "credentials", reason: `the job has no credentials to read s3://${bucket}: ${(e as Error).message}` };
  }
  return {
    backend: "s3",
    bucket,
    key: s3StateKey(key, ws, str(c.workspace_key_prefix)),
    region,
    ...(endpoint ? { endpoint: endpoint.replace(/\/+$/, "") } : {}),
    lockfile: true,
    target,
  };
}

/** A gcs backend's custom endpoint (`storage_custom_endpoint`, `https://host/storage/v1/`) as the JSON API's address: no path, no trailing slash. */
const gcsEndpoint = (e: string): string => e.replace(/\/+$/, "").replace(/\/storage\/v1$/, "");

/**
 * A gcs backend's state: `<prefix>/<workspace>.tfstate` and its lock beside
 * it, with the credentials the backend would use, first match wins:
 * `access_token` (or GOOGLE_OAUTH_ACCESS_TOKEN), `credentials` (a file or its
 * JSON), GOOGLE_BACKEND_CREDENTIALS, GOOGLE_CREDENTIALS, and
 * GOOGLE_APPLICATION_CREDENTIALS.
 */
function gcsObject(c: Record<string, unknown>, ws: string, env: NodeJS.ProcessEnv): StateObject {
  const bucket = str(c.bucket);
  if (!bucket) return { backend: "gcs", refused: "config", reason: "the gcs backend's bucket is not in the configuration init recorded" };
  const raw = str(c.prefix) ?? "";
  const prefix = raw === "" || raw.endsWith("/") ? raw : `${raw}/`;
  const endpoint = gcsEndpoint(str(c.storage_custom_endpoint) ?? env.GOOGLE_BACKEND_STORAGE_CUSTOM_ENDPOINT ?? env.GOOGLE_STORAGE_CUSTOM_ENDPOINT ?? GCS_ENDPOINT);
  const impersonate = str(c.impersonate_service_account) ?? env.GOOGLE_BACKEND_IMPERSONATE_SERVICE_ACCOUNT ?? env.GOOGLE_IMPERSONATE_SERVICE_ACCOUNT;
  const where = { bucket, endpoint, ...(impersonate ? { impersonate } : {}) };
  const token = str(c.access_token) ?? env.GOOGLE_OAUTH_ACCESS_TOKEN;
  const creds = str(c.credentials) ?? env.GOOGLE_BACKEND_CREDENTIALS ?? env.GOOGLE_CREDENTIALS;
  let target: GcsTarget;
  if (token) target = { ...where, accessToken: token };
  else if (creds) target = creds.trim().startsWith("{") ? { ...where, credentialsJson: creds } : { ...where, credentialsFile: creds };
  else if (env.GOOGLE_APPLICATION_CREDENTIALS) target = { ...where, credentialsFile: env.GOOGLE_APPLICATION_CREDENTIALS };
  else return { backend: "gcs", refused: "credentials", reason: `the job has no credentials to read gs://${bucket}: set GOOGLE_APPLICATION_CREDENTIALS, GOOGLE_CREDENTIALS or GOOGLE_OAUTH_ACCESS_TOKEN` };
  return { backend: "gcs", bucket, key: `${prefix}${ws}.tfstate`, lock: `${prefix}${ws}.tflock`, target };
}

/** Each Azure cloud's storage suffix and Entra ID, by the azurerm backend's `environment`. */
const CLOUD_ENDPOINTS: Record<string, { storage: string; authority: string }> = {
  public: { storage: "core.windows.net", authority: AZURE_AUTHORITY },
  china: { storage: "core.chinacloudapi.cn", authority: "https://login.chinacloudapi.cn" },
  usgovernment: { storage: "core.usgovcloudapi.net", authority: "https://login.microsoftonline.us" },
};

/**
 * An azurerm backend's state: the blob `key` in `container_name` of
 * `storage_account_name`, `<key>env:<workspace>` in another workspace, with
 * the credentials the backend would use: `access_key` (ARM_ACCESS_KEY),
 * `sas_token` (ARM_SAS_TOKEN), else the job's OIDC identity. An
 * `environment` other than public, china or usgovernment is refused: its
 * storage suffix would need the metadata lookup terragucci makes and chant
 * does not.
 */
function azureObject(c: Record<string, unknown>, ws: string, env: NodeJS.ProcessEnv): StateObject {
  const account = str(c.storage_account_name);
  const container = str(c.container_name);
  const base = str(c.key);
  if (!account || !container || !base) return { backend: "azurerm", refused: "config", reason: "the azurerm backend's storage_account_name, container_name or key is not in the configuration init recorded" };
  const key = ws === "default" ? base : `${base}env:${ws}`;
  const cloud = CLOUD_ENDPOINTS[str(c.environment) ?? env.ARM_ENVIRONMENT ?? "public"];
  if (!cloud) return { backend: "azurerm", refused: "config", reason: `the azurerm backend's environment ${str(c.environment) ?? env.ARM_ENVIRONMENT} is not public, china or usgovernment` };
  const accessKey = str(c.access_key) ?? env.ARM_ACCESS_KEY;
  const sas = str(c.sas_token) ?? env.ARM_SAS_TOKEN;
  const tenantId = str(c.tenant_id) ?? env.ARM_TENANT_ID;
  const clientId = str(c.client_id) ?? env.ARM_CLIENT_ID;
  const tokenFile = str(c.oidc_token_file_path) ?? env.ARM_OIDC_TOKEN_FILE_PATH;
  let auth: AzureAuth;
  if (accessKey) auth = { accountKey: accessKey };
  else if (sas) auth = { sas };
  else if (tenantId && clientId && tokenFile) auth = { oidc: { tenantId, clientId, tokenFile, authority: (env.AZURE_AUTHORITY_HOST || cloud.authority).replace(/\/+$/, "") } };
  else return { backend: "azurerm", refused: "credentials", reason: `the job has no credentials to read the container ${container} of ${account}: set ARM_ACCESS_KEY, ARM_SAS_TOKEN, or ARM_TENANT_ID, ARM_CLIENT_ID and ARM_OIDC_TOKEN_FILE_PATH` };
  return { backend: "azurerm", account, container, key, snapshot: c.snapshot === true || env.ARM_SNAPSHOT === "true", endpoint: `https://${account}.blob.${cloud.storage}`, auth };
}

/** `s3://<bucket>/<key>`, `gs://<bucket>/<key>`, `az://<account>/<container>/<key>`, or the local file's path; undefined for a refusal. */
export function stateLocation(o: StateObject): string | undefined {
  if (isRefused(o)) return undefined;
  if (o.backend === "local") return o.path;
  if (o.backend === "gcs") return `gs://${o.bucket}/${o.key}`;
  if (o.backend === "azurerm") return `az://${o.account}/${o.container}/${o.key}`;
  return `s3://${o.bucket}/${o.key}`;
}
