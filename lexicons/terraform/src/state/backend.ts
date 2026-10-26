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
 * This is also the one place that answers which backend a root has and
 * whether chant can lock it (chant#4478). Before `init` the answer comes
 * from the root's code with the `-backend-config` pairs over it
 * ({@link declaredBackend}); after, from what `init` recorded. When both
 * exist and disagree the root is refused with a reason naming both
 * ({@link readBackend}, {@link lockRefusal}). The composition's `backend`
 * fallback and the state refusals both call {@link lockRefusal}, so one root
 * gets one verdict.
 *
 * Lifted from terragucci's `backend.ts` (c493e0e): `initialisedBackend`,
 * `dataDir`, `workspaceOf`, `s3StateKey`, `stateObject`, `isStored`,
 * `stateLocation`, and the cloud block check of `migrate.ts`'s `refusal`.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { AZURE_AUTHORITY, type AzureOidc } from "./azure-blob";
import { GCS_ENDPOINT, type GcsTarget } from "./gcs";
import { s3FromEnv, type S3Target } from "./s3";
import { isJsonConfigFile, listConfigFilesSafe } from "../hcl/files";
import { blockBody, jsonBlocks, rootTexts } from "../compose/hcl";

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
export type StateRefusalKind = "cloud" | "no-lockfile" | "backend" | "config" | "credentials" | "disagree";

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

/** The backend types whose state chant locks and writes itself, s3 only with `use_lockfile = true` (#4437). The one list (chant#4478). */
export const LOCKABLE_BACKENDS: readonly string[] = ["s3", "gcs", "azurerm", "local"];

/** What a refusal says chant locks, spelled from {@link LOCKABLE_BACKENDS}. */
export const LOCKS = (() => {
  const names = LOCKABLE_BACKENDS.map((b) => (b === "s3" ? "s3 (with use_lockfile = true)" : b));
  return `chant locks and writes ${names.slice(0, -1).join(", ")} and ${names.at(-1)} states`;
})();

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

/**
 * Whether the root's code has a `cloud` block, over the configuration files
 * `binary` reads: `.tf` and `.tf.json`, plus `.tofu` and `.tofu.json` for a
 * tofu or choudoufu root, from the lexicon's one lister (chant#4457).
 */
export function hasCloudBlock(dir: string, binary?: string): boolean {
  for (const f of listConfigFilesSafe(dir, binary)) {
    let text: string;
    try {
      text = readFileSync(join(dir, f), "utf-8");
    } catch {
      continue;
    }
    if (!isJsonConfigFile(f)) {
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

/** Where a root's backend is read from, before `init` runs. */
export interface DeclaredBackendInput {
  /** `terraform.roots.<name>.backendConfig`: the `-backend-config` pairs chant's own init passes, last. */
  backendConfig?: Readonly<Record<string, string>>;
  /** The job's environment: its `TF_CLI_ARGS` and `TF_CLI_ARGS_init` may carry `-backend-config` flags. */
  env?: NodeJS.ProcessEnv;
  /** `terraform.binary`, which says which of the root's files are its code (chant#4457). */
  binary?: string;
}

/** A `-backend-config` value as init would type it: `true` and `false` are booleans, anything else a string. */
const typed = (v: string): unknown => (v === "true" ? true : v === "false" ? false : v);

/** The `-backend-config` flags in `TF_CLI_ARGS` then `TF_CLI_ARGS_init`, in order: `key=value` pairs, and the paths of backend-config files. */
export function cliBackendConfig(env: NodeJS.ProcessEnv = {}): { pairs: Record<string, string>; files: string[] } {
  const pairs: Record<string, string> = {};
  const files: string[] = [];
  const unquote = (t: string): string => t.replace(/^(["'])(.*)\1$/, "$2");
  for (const line of [env.TF_CLI_ARGS, env.TF_CLI_ARGS_init]) {
    const tokens = (line ?? "").match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
    for (let i = 0; i < tokens.length; i++) {
      const t = unquote(tokens[i]!);
      const flag = /^--?backend-config(?:=(.*))?$/.exec(t);
      if (!flag) continue;
      const value = flag[1] !== undefined ? unquote(flag[1]) : tokens[i + 1] !== undefined ? unquote(tokens[++i]!) : undefined;
      if (value === undefined || value === "") continue;
      const eq = value.indexOf("=");
      if (eq > 0) pairs[value.slice(0, eq)] = value.slice(eq + 1);
      else files.push(value);
    }
  }
  return { pairs, files };
}

/** An HCL block's body with everything inside its nested braces blanked, so only its own attributes are left to read. */
function ownLevel(body: string): string {
  const out = body.split("");
  let depth = 0;
  let inString = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (depth >= 2 && c !== "\n") out[i] = " ";
    if (inString) {
      if (c === "\\") {
        if (depth >= 2 && body[i + 1] !== "\n") out[i + 1] = " ";
        i++;
      } else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
  }
  return out.join("");
}

/** A backend block's own literal attributes: plain strings, booleans and numbers. A string with an interpolation is left out. */
function hclBackendAttrs(body: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const m of ownLevel(body).matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("(?:[^"\\]|\\.)*"|true|false|-?\d+(?:\.\d+)?)\s*$/gm)) {
    const raw = m[2]!;
    if (raw.startsWith('"')) {
      const text = raw.slice(1, -1);
      if (/\$\{|%\{/.test(text)) continue;
      out[m[1]!] = text.replace(/\\(.)/g, "$1");
    } else out[m[1]!] = raw === "true" ? true : raw === "false" ? false : Number(raw);
  }
  return out;
}

const plain = (v: unknown): v is string | number | boolean => typeof v === "string" || typeof v === "number" || typeof v === "boolean";

/**
 * The backend the root's code declares, with the `-backend-config` flags of
 * `TF_CLI_ARGS`, `TF_CLI_ARGS_init` and then `backendConfig` over it, in the
 * order init applies them: what `init` would record, as far as chant can read
 * it before init runs. A `cloud` block is `{ type: "cloud" }`. Undefined when
 * the code declares neither, which init records as no backend (local).
 */
export function declaredBackend(dir: string, input: DeclaredBackendInput = {}): InitialisedBackend | undefined {
  let found: InitialisedBackend | undefined;
  for (const { text, json } of rootTexts(dir, input.binary)) {
    if (found) break;
    if (json) {
      let doc: unknown;
      try {
        doc = JSON.parse(text);
      } catch {
        continue;
      }
      for (const t of jsonBlocks(doc, "terraform")) {
        if (t.cloud !== undefined) {
          found = { type: "cloud", config: {} };
          break;
        }
        const backends = t.backend && typeof t.backend === "object" && !Array.isArray(t.backend) ? (t.backend as Record<string, unknown>) : {};
        const type = Object.keys(backends)[0];
        if (!type) continue;
        const raw = backends[type];
        const body = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | undefined;
        found = { type, config: Object.fromEntries(Object.entries(body ?? {}).filter(([, v]) => plain(v) && !(typeof v === "string" && /\$\{/.test(v)))) };
        break;
      }
      continue;
    }
    const m = text.match(/\bbackend\s+"([^"]+)"\s*\{/);
    if (m) {
      found = { type: m[1]!, config: hclBackendAttrs(blockBody(text, m.index!)) };
      break;
    }
    if (/^\s*cloud\s*\{/m.test(text)) found = { type: "cloud", config: {} };
  }
  if (!found || found.type === "cloud") return found;
  const config = { ...found.config };
  for (const [k, v] of Object.entries(cliBackendConfig(input.env).pairs)) config[k] = typed(v);
  for (const [k, v] of Object.entries(input.backendConfig ?? {})) config[k] = typed(v);
  return { type: found.type, config };
}

/** Configuration keys whose values a reason names but never prints. */
const SECRET_KEYS = /(^|_)(key|secret|token|password|credentials|sas)($|_)/;

const shown = (k: string, v: unknown): string => (SECRET_KEYS.test(k) && k !== "key" ? `${k} (value hidden)` : `${k} = ${JSON.stringify(v)}`);

/** A root's backend as both sources give it, and the one the verdict reads. */
export interface BackendReading {
  /** From the root's code and the `-backend-config` flags, before init. */
  declared?: InitialisedBackend;
  /** What `init` recorded. */
  recorded?: InitialisedBackend;
  /** The recorded backend when there is one, else the declared one, else local. */
  backend: InitialisedBackend;
  /** Why the two disagree, naming both, when both exist and they do. */
  disagreement?: string;
}

/** Where a root's backend is read from: {@link DeclaredBackendInput}, plus what `init` recorded, which the root's data dir holds unless given. */
export interface ReadBackendInput extends DeclaredBackendInput {
  /** What `init` recorded; `null` for none. Read from the root's data dir when absent. */
  recorded?: InitialisedBackend | null;
}

/**
 * A root's backend from its code and flags and from what `init` recorded,
 * compared (chant#4478). They disagree when both exist and name another type,
 * or when a key both give a plain value has two values; a key only one side
 * gives (a default init filled in, a value from a backend-config file chant
 * did not read) is no disagreement. Code that declares no backend leaves the
 * record to stand.
 */
export function readBackend(dir: string, input: ReadBackendInput = {}): BackendReading {
  const env = input.env ?? process.env;
  const declared = declaredBackend(dir, input);
  const recorded = input.recorded === undefined ? initialisedBackend(dir, env) : (input.recorded ?? undefined);
  const backend = recorded ?? declared ?? { type: "local", config: {} };
  const out: BackendReading = { ...(declared ? { declared } : {}), ...(recorded ? { recorded } : {}), backend };
  if (!declared || !recorded) return out;
  if (declared.type !== recorded.type) {
    out.disagreement = `the root's code names the ${declared.type} backend and init recorded ${recorded.type}`;
    return out;
  }
  const differ: string[] = [];
  for (const [k, d] of Object.entries(declared.config)) {
    const r = recorded.config[k];
    if (!plain(d) || !plain(r) || String(d) === String(r)) continue;
    differ.push(`${shown(k, d)} in the code and flags, ${shown(k, r)} in what init recorded`);
  }
  if (differ.length > 0) out.disagreement = `the root's ${declared.type} backend has ${differ.join("; ")}`;
  return out;
}

/**
 * Whether chant can lock the root's state, from one {@link BackendReading}:
 * undefined when it can, else the refusal and why. The one verdict the
 * composition's `backend` fallback (#4438) and the state refusals (#4437)
 * both give (chant#4478).
 */
export function lockRefusal(reading: BackendReading): StateRefusal | undefined {
  const b = reading.backend;
  if (reading.disagreement) return { backend: b.type, refused: "disagree", reason: `${reading.disagreement}, so chant cannot tell which state to lock; run init again with the configuration the root means; ${LOCKS}` };
  if (b.type === "cloud") return { backend: b.type, refused: "cloud", reason: `${CLOUD_REASON}; ${LOCKS}` };
  if (!LOCKABLE_BACKENDS.includes(b.type)) return { backend: b.type, refused: "backend", reason: `the root's backend is ${b.type}; ${LOCKS}` };
  if (b.type === "s3" && b.config.use_lockfile !== true && b.config.use_lockfile !== "true") {
    return { backend: "s3", refused: "no-lockfile", reason: `the s3 backend takes no lock file (use_lockfile = true is unset), so chant cannot hold its lock; ${LOCKS}` };
  }
  return undefined;
}

/**
 * Where the root's state is, or why chant does not lock it, from
 * {@link readBackend}: what `init` recorded (`backend` stands in for it),
 * compared with the root's code and `backendConfig`. A root neither declares
 * nor records a backend for reads as a local one.
 */
export function stateObject(
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
  backend: InitialisedBackend | undefined = initialisedBackend(dir, env),
  binary?: string,
  backendConfig?: Readonly<Record<string, string>>,
): StateObject {
  const reading = readBackend(dir, { env, recorded: backend ?? null, ...(binary ? { binary } : {}), ...(backendConfig ? { backendConfig } : {}) });
  const refusal = lockRefusal(reading);
  if (refusal) return refusal;
  const chosen = reading.backend;
  const ws = workspaceOf(dir, env);
  if (chosen.type === "local") {
    const c = chosen.config;
    const path = ws === "default" ? (str(c.path) ?? "terraform.tfstate") : join(str(c.workspace_dir) ?? "terraform.tfstate.d", ws, "terraform.tfstate");
    return { backend: "local", path };
  }
  if (chosen.type === "gcs") return gcsObject(chosen.config, ws, env);
  if (chosen.type === "azurerm") return azureObject(chosen.config, ws, env);
  const c = chosen.config;
  const bucket = str(c.bucket);
  const key = str(c.key);
  if (!bucket || !key) return { backend: "s3", refused: "config", reason: "the s3 backend's bucket or key is not in its configuration (the code and flags, or what init recorded)" };
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
