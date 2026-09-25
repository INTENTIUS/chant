/**
 * Box — a persistent machine that serves an app repo and its tools (#2705).
 *
 * A box is an `Environment` whose repositories hold the app repo and whose
 * `setup_script` provisions the machine (for an arugula studio box, the
 * studio's `box/provision-template.sh`), an `Agent` on a persistent sandbox
 * provisioned from it, and optionally a `Vault` for the secrets every box of
 * this kind shares.
 *
 * ```ts
 * export const { environment, agent, vault } = Box({
 *   name: "studio-box",
 *   repo: { url: "https://github.com/arugula-salad/studio", ref: "main" },
 *   setupScript: readFileSync("box/provision-template.sh", "utf8"),
 *   permissionPolicy: { default: "auto_allow" },
 *   allowedHosts: ["registry.npmjs.org", "github.com"],
 *   vault: { secrets: [{ key: "STUDIO_SECRET", value: process.env.STUDIO_SECRET! }] },
 * });
 * ```
 *
 * Beside `Steward`: a steward is an environment's one writer, an `acp` agent
 * whose every turn is a chant command line, bound to a teammate with a
 * standing thread and schedules. A box is where people and their agents work
 * on an app: a conversational runtime (`claude` by default), the app repo
 * cloned in, the provisioning script run as setup, and one served port. It
 * declares no teammate and no schedule, and nothing here starts a
 * conversation. Starting and reaping a box stays a runtime act, as it is in
 * hud's box runtime.
 *
 * The defaults are the closed ones, as `ConciergeStack`'s are, and loosening
 * one is a visible parameter: networking is `limited` with an empty allowlist
 * until `allowedHosts` names hosts or `unrestrictedNetworking: true` opens it
 * (which FTN011 then warns about); `allowed_vault_ids` holds the box's own
 * vault, or nothing, until `allowedVaults` widens it. `permission_policy` has
 * no default at all, because fountain's unset policy is `auto_allow` and that
 * should be a choice someone wrote down.
 *
 * ## The port
 *
 * fountain's `Environment` and `Agent` have no field for a served port (the
 * pinned spec, v0.21.0). The port is recorded in the metadata of both, under
 * `box-port`, and returned as `port`, so whatever builds the box's URL reads
 * it from the declaration or from fountain's own record without a guess.
 */

import { Agent, Environment, Vault } from "../generated/index";

/** The metadata key a box's served port is recorded under, on its Environment and Agent. */
export const BOX_PORT_METADATA_KEY = "box-port";

/** The port a box serves when none is given: the door's. */
export const BOX_DEFAULT_PORT = 8080;

/** Where the app repo is cloned when no `mountPath` is given. */
export const BOX_DEFAULT_MOUNT_PATH = "/workspace/app";

/** A permission verdict, or a number of seconds under the `ask_timeout` key. */
export type BoxPermissionPolicy = Record<string, "ask" | "auto_allow" | "auto_deny" | number>;

/** The app repo the box serves. Shape of fountain's `Repository`. */
export interface BoxRepositoryOpts {
  /** https clone url. */
  url: string;
  /** Absolute path the repo is cloned to. Default `/workspace/app`. */
  mountPath?: string;
  /** Branch or tag. The default branch when omitted. */
  ref?: string;
  /** Name of the secret holding a clone token. Required for a private repo. */
  secretKey?: string;
}

/** The secrets every box of this kind shares, held in a Vault of the box's own. */
export interface BoxVaultOpts {
  /** Vault name. Default `<name>-secrets`. */
  name?: string;
  description?: string;
  /** Written at apply. A reference that resolves at build, never a literal (FTN001). */
  secrets?: { key: string; value: string }[];
}

export interface BoxOpts {
  /** The Agent's name. The Environment is `<name>-env`. */
  name: string;
  /** The app repo the box serves, cloned into the sandbox before setup runs. */
  repo: BoxRepositoryOpts;
  /** The provisioning script's text, run as the Environment's `setup_script`. */
  setupScript: string;
  /** Setup exec timeout, 1 to 900 seconds (FTN024). fountain's default is 120. */
  setupTimeoutSeconds?: number;
  /** Agent runtime. Default `claude`. */
  runtime?: "claude" | "codex" | "gemini" | "opencode";
  /** Canonical provider/model_id. Omitted, fountain's default for the runtime. */
  model?: string;
  /** Per-tool permission policy. Required: fountain's unset policy is `auto_allow`. */
  permissionPolicy: BoxPermissionPolicy;
  /** Environment packages, passed through. */
  packages?: Record<string, unknown>;
  /** Environment variables, passed through. Not for secrets: use `vault`. */
  envVars?: Record<string, string>;
  /** Egress allowlist under `limited` networking. Default [], deny-all. */
  allowedHosts?: string[];
  /** Open the sandbox's network. FTN011 warns on it. Refused with `allowedHosts`. */
  unrestrictedNetworking?: boolean;
  /** Declare a Vault for the box's shared secrets. */
  vault?: BoxVaultOpts;
  /**
   * Vaults a conversation may attach. Default: the box's own vault, or none.
   * `"any"` leaves the list unset, which fountain reads as any vault the
   * tenant owns: what a runtime that makes a vault per box (hud's) needs.
   */
  allowedVaults?: "any" | Array<InstanceType<typeof Vault> | string>;
  /** The port the box serves. Default 8080, the door's. Recorded as `box-port` metadata. */
  port?: number;
  system?: string;
  skills?: Array<Record<string, unknown>>;
  mcpServers?: Record<string, unknown>;
  /** Extra metadata, merged over the ownership marker on every resource the box declares. */
  metadata?: Record<string, unknown>;
}

export interface BoxResources {
  environment: InstanceType<typeof Environment>;
  agent: InstanceType<typeof Agent>;
  vault?: InstanceType<typeof Vault>;
  /** The served port, as recorded under `box-port`. */
  port: number;
}

export function Box(opts: BoxOpts): BoxResources {
  const port = opts.port ?? BOX_DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Box "${opts.name}": port ${port} is not a TCP port (1 to 65535)`);
  }
  if (opts.unrestrictedNetworking && opts.allowedHosts !== undefined) {
    throw new Error(
      `Box "${opts.name}": allowedHosts and unrestrictedNetworking together — ` +
        `an allowlist means nothing on an open network. Pass one.`,
    );
  }
  if (!opts.setupScript.trim()) {
    throw new Error(`Box "${opts.name}": setupScript is empty — a box is provisioned by its setup script`);
  }

  const owned = { "managed-by": "chant", ...(opts.metadata ?? {}) };
  const metadata = { ...owned, [BOX_PORT_METADATA_KEY]: port };

  const repository = {
    url: opts.repo.url,
    mount_path: opts.repo.mountPath ?? BOX_DEFAULT_MOUNT_PATH,
    ...(opts.repo.ref !== undefined ? { ref: opts.repo.ref } : {}),
    ...(opts.repo.secretKey !== undefined ? { secret_key: opts.repo.secretKey } : {}),
  };

  const environment = new Environment({
    name: `${opts.name}-env`,
    repositories: [repository],
    setup_script: opts.setupScript,
    ...(opts.setupTimeoutSeconds !== undefined ? { setup_timeout_seconds: opts.setupTimeoutSeconds } : {}),
    ...(opts.packages ? { packages: opts.packages } : {}),
    ...(opts.envVars ? { env_vars: opts.envVars } : {}),
    ...(opts.unrestrictedNetworking
      ? { networking_type: "unrestricted" as const }
      : { networking_type: "limited" as const, networking_config: { allowed_hosts: opts.allowedHosts ?? [] } }),
    metadata,
  });

  const vault = opts.vault
    ? new Vault({
        name: opts.vault.name ?? `${opts.name}-secrets`,
        ...(opts.vault.description !== undefined ? { description: opts.vault.description } : {}),
        ...(opts.vault.secrets ? { secrets: opts.vault.secrets } : {}),
        metadata: owned,
      })
    : undefined;

  // A Vault declaration rather than its `.id`, as in Steward: the manifest's
  // reference form is the resource's name (FTN021), and an AttrRef would
  // serialize to the chant export name instead.
  const allowedVaults =
    opts.allowedVaults === "any" ? undefined : (opts.allowedVaults ?? (vault ? [vault] : []));

  const agent = new Agent({
    name: opts.name,
    runtime: opts.runtime ?? "claude",
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    sandbox_mode: "persistent",
    environment,
    permission_policy: opts.permissionPolicy,
    ...(allowedVaults !== undefined ? { allowed_vault_ids: allowedVaults } : {}),
    ...(opts.skills ? { skills: opts.skills } : {}),
    ...(opts.mcpServers ? { mcp_servers: opts.mcpServers } : {}),
    ...(opts.system !== undefined ? { system: opts.system } : {}),
    metadata,
  });

  return { environment, agent, ...(vault ? { vault } : {}), port };
}
