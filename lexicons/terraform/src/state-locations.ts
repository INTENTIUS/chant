/**
 * Where each Terraform root's state lives (#5456), as the entries `chant
 * workspace state` reads from the member graph's `meta.stateLocations`.
 *
 * A root's backend is what its code declares with the `-backend-config`
 * files, pairs and `TF_CLI_ARGS` flags applied over it ({@link declaredBackend}),
 * the same reading the state and lock paths use. A root's environment is its
 * `estate`, else its `workspace`, and an s3 key as the backend names it for a
 * non-default workspace (`env:/<workspace>/<key>`). A root with a choudoufu
 * live block also has its record store. Text reads only: nothing is run, no
 * bucket is called, so `reach` is `unchecked`.
 */
import { resolve } from "node:path";
import { declaredBackend } from "./state/backend";
import { writtenRecordStore } from "./live-roots";

type Scalar = string | number | boolean | null;

export interface TerraformStateLocation {
  environment: string | null;
  unit: string;
  substrate: "terraform";
  backend: { kind: string; location: Record<string, Scalar> };
  lock: { mechanism: string; location?: Record<string, Scalar> } | null;
  reach: { status: "unchecked"; reason: string };
}

/** The root fields a location is read from. */
export interface StateRoot {
  dir: string;
  workspace?: string;
  estate?: string;
  backendConfig?: Readonly<Record<string, string>>;
  backendConfigFiles?: readonly string[];
}

const UNCHECKED = { status: "unchecked" as const, reason: "the location is read from configuration; no call is made to it" };

const text = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** An s3 backend's key for a workspace: the backend's own rule, `<prefix>/<workspace>/<key>` with `env:` as the default prefix. */
function s3Key(config: Record<string, unknown>, workspace: string | undefined): string | null {
  const key = text(config.key);
  if (!key || !workspace || workspace === "default") return key;
  return `${text(config.workspace_key_prefix) ?? "env:"}/${workspace}/${key}`;
}

function located(config: Record<string, unknown>, keys: readonly string[]): Record<string, Scalar> {
  return Object.fromEntries(keys.map((k) => [k, typeof config[k] === "number" || typeof config[k] === "boolean" ? (config[k] as number | boolean) : text(config[k])]));
}

/** One backend as a location and a lock. A backend chant has no reading for keeps its type and the keys it names. */
export function backendLocation(
  type: string,
  config: Record<string, unknown>,
  workspace: string | undefined,
): { backend: TerraformStateLocation["backend"]; lock: TerraformStateLocation["lock"] } {
  switch (type) {
    case "s3": {
      const key = s3Key(config, workspace);
      const lockfile = config.use_lockfile === true;
      const table = text(config.dynamodb_table);
      return {
        backend: { kind: "s3", location: { bucket: text(config.bucket), key, region: text(config.region) } },
        lock: lockfile
          ? { mechanism: "s3-lockfile", location: { key: key ? `${key}.tflock` : null } }
          : table
            ? { mechanism: "dynamodb", location: { table } }
            : null,
      };
    }
    case "gcs":
      return {
        backend: { kind: "gcs", location: { bucket: text(config.bucket), prefix: text(config.prefix) } },
        lock: { mechanism: "gcs-object" },
      };
    case "azurerm":
      return {
        backend: { kind: "azurerm", location: located(config, ["storage_account_name", "container_name", "key", "resource_group_name"]) },
        lock: { mechanism: "blob-lease" },
      };
    case "http":
      return {
        backend: { kind: "http", location: located(config, ["address"]) },
        lock: text(config.lock_address) ? { mechanism: "http-lock", location: located(config, ["lock_address"]) } : null,
      };
    case "local":
      return { backend: { kind: "local", location: { path: text(config.path) ?? "terraform.tfstate" } }, lock: { mechanism: "local-file" } };
    case "cloud":
      return { backend: { kind: "cloud", location: located(config, ["organization", "hostname"]) }, lock: { mechanism: "terraform-cloud" } };
    default:
      return { backend: { kind: type, location: located(config, Object.keys(config).sort()) }, lock: null };
  }
}

/**
 * The state locations of the given roots, in name order: one for each root's
 * backend, and one for the record store of each root with a live block.
 */
export function terraformStateLocations(
  projectRoot: string,
  roots: Readonly<Record<string, StateRoot>>,
  options: { binary?: string; env?: NodeJS.ProcessEnv } = {},
): TerraformStateLocation[] {
  const out: TerraformStateLocation[] = [];
  for (const name of Object.keys(roots).sort()) {
    const root = roots[name]!;
    const dir = resolve(projectRoot, root.dir);
    // A live root's estate is its environment (config.ts); a stock root's is its workspace.
    const environment = root.estate ?? root.workspace ?? null;
    const declared = declaredBackend(dir, {
      binary: options.binary,
      env: options.env ?? process.env,
      ...(root.backendConfig ? { backendConfig: root.backendConfig } : {}),
      ...(root.backendConfigFiles ? { backendConfigFiles: root.backendConfigFiles } : {}),
    });
    // No backend block is the local backend, which init records as no backend at all.
    const { backend, lock } = backendLocation(declared?.type ?? "local", declared?.config ?? {}, root.workspace);
    out.push({ environment, unit: name, substrate: "terraform", backend, lock, reach: UNCHECKED });

    const store = writtenRecordStore(dir, root.estate ?? name, options.binary);
    if (store) {
      out.push({
        environment,
        unit: `${name} (records)`,
        substrate: "terraform",
        backend:
          store.kind === "s3"
            ? { kind: "choudoufu-record-store:s3", location: { bucket: store.bucket, prefix: store.prefix, region: store.region ?? null } }
            : store.kind === "local"
              ? { kind: "choudoufu-record-store:local", location: { dir: store.dir, prefix: store.prefix } }
              : { kind: `choudoufu-record-store:${store.name}`, location: {} },
        lock: null,
        reach: UNCHECKED,
      });
    }
  }
  return out;
}
