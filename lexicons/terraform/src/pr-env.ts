/**
 * A pull request's copy of Terraform roots (#4762): each root initialised
 * under its backend's state key with the environment's suffix, planned,
 * applied, and destroyed when the pull request closes or its TTL passes.
 * chant core runs the environment (`components/pr-env-run`: the gate, the
 * records, the TTL, the sweep) and its component rules
 * (`components/pr-env-components`); this module is the Terraform part.
 *
 * Why a key suffix and not a workspace: the other stages read a root's state
 * from its backend block, and a workspace would put the copy in the same
 * namespace as the root under a name only the binary resolves. A suffixed
 * key is a state of its own that the backend block, the lock and the bucket
 * listing all name plainly.
 *
 *   s3, azurerm  `key`: `envs/dev/terraform.tfstate` becomes
 *                `envs/dev/terraform-pr-7.tfstate`
 *   gcs          `prefix`: `envs/dev` becomes `envs/dev-pr-7`
 *   local        `path`
 *   http         `address`, when it is a GitLab project's state API: the
 *                copy is the state `<name>-pr-7`, and its lock and unlock
 *                addresses take the same name
 *
 * The copy's `-backend-config` comes from the root's code and the job's
 * `TF_CLI_ARGS` (`declaredBackend`). A root another tool prepares, such as
 * a Terragrunt unit whose `remote_state` reads the suffix from the
 * environment, passes `prepare`; its recorded backend must then carry the
 * suffix, or the copy is refused, so a copy never plans, applies or destroys
 * at a root's own key.
 *
 * Lifted from terragucci's `ephemeral.ts` (`suffixedKey`, `KEY_ATTRIBUTE`,
 * `gitlabCopy`, `copyBackend`, `unitBackend`, `carriesSuffix`, `planCopy`,
 * `copyAdapter`, `ephemeralTeardown`), so terragucci deletes its copy and
 * keeps its words: its checkout of the pull request, its synth command, its
 * Terragrunt preparation and its binary per root.
 */
import { join } from "node:path";
import { componentsPrEnvAdapter, componentsPrEnvTeardown, type PrEnvComponentPlan } from "@intentius/chant/components/pr-env-components";
import type { PrEnvAdapter } from "@intentius/chant/components/pr-env-run";
import type { LivePrEnvironment, PrEnvTeardownAdapter } from "@intentius/chant/components/pr-environment";
import type { BinaryExec } from "./state/exec";
import { declaredBackend, initialisedBackend } from "./state/backend";
import { isGitLabAddress, shownUrl, suffixedGitLabAddress } from "./state/gitlab";
import { applyPlanFile, planCopy } from "./state-ops";

/** The backends a copy can be given a key of its own on, and the attribute that holds the key. */
export const KEY_ATTRIBUTE: Readonly<Record<string, string>> = { s3: "key", azurerm: "key", gcs: "prefix", local: "path", http: "address" };

/** The http backend's attributes that name the state too: its lock's, `<address>/lock` on GitLab. */
export const HTTP_LOCK_ATTRIBUTES = ["lock_address", "unlock_address"] as const;

const BACKENDS = Object.keys(KEY_ATTRIBUTE).join(", ");

/** A root no copy can be made of, or a prepared root whose key is its own. A config error: nothing planned. */
export class CopyRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CopyRefusedError";
  }
}

/**
 * A state key with the suffix: before a closing `.tfstate`, else at the end.
 * `envs/dev/terraform.tfstate` becomes `envs/dev/terraform-pr-7.tfstate`.
 */
export function suffixedKey(key: string, suffix: string): string {
  const k = key.replace(/\/+$/, "");
  return /\.tfstate$/.test(k) ? k.replace(/\.tfstate$/, `-${suffix}.tfstate`) : `${k}-${suffix}`;
}

/** Whether a key or location carries a copy's suffix as {@link suffixedKey} puts it. A GitLab lock address is read without its `/lock`. */
export const carriesSuffix = (key: string, suffix: string): boolean => new RegExp(`-${suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\.tfstate)?/*$`).test(key.replace(/\/lock\/?$/, ""));

/** Where a copy's state is, for messages and the record. */
function locationOf(type: string, config: Record<string, unknown>, key: string): string {
  const s = (k: string): string | undefined => (typeof config[k] === "string" && config[k] !== "" ? (config[k] as string) : undefined);
  if (type === "http") return shownUrl(key);
  if (type === "s3" && s("bucket")) return `s3://${s("bucket")}/${key}`;
  if (type === "gcs" && s("bucket")) return `gs://${s("bucket")}/${key}`;
  if (type === "azurerm" && s("container_name")) return `az://${s("storage_account_name") ?? "azure"}/${s("container_name")}/${key}`;
  return key;
}

/** A copy's backend: the attribute and suffixed key, any other attribute it sets, and where the copy is. */
export interface CopyBackend {
  type: string;
  attribute: string;
  key: string;
  location: string;
  /** Further `-backend-config` pairs: a GitLab copy's lock addresses. */
  extra?: Record<string, string>;
}

/**
 * A GitLab-managed state's attributes for its copy: the address and each
 * lock address with the state name suffixed. Each is the configured one,
 * else its `TF_HTTP_*` variable, as the binary reads it.
 */
export function gitlabCopy(root: string, config: Record<string, unknown>, env: NodeJS.ProcessEnv, suffix: string): { key: string; extra: Record<string, string> } {
  const given = (name: string): string | undefined => (typeof config[name] === "string" && config[name] !== "" ? (config[name] as string) : env[`TF_HTTP_${name.toUpperCase()}`] || undefined);
  const address = given("address");
  if (!address) throw new CopyRefusedError(`${root}'s http backend names no address, in the block or TF_HTTP_ADDRESS, so there is no state name to give its copy a suffix`);
  const key = suffixedGitLabAddress(address, suffix);
  if (!key) throw new CopyRefusedError(`${root}'s http backend address ${shownUrl(address)} is not a GitLab project's state API (.../projects/<id>/terraform/state/<name>), and a copy of an http backend's state is made on GitLab-managed state only`);
  const extra: Record<string, string> = {};
  for (const name of HTTP_LOCK_ATTRIBUTES) {
    const v = given(name);
    if (!v) continue;
    const suffixed = suffixedGitLabAddress(v, suffix);
    if (!suffixed || suffixedGitLabAddress(v.replace(/\/lock\/?$/, ""), suffix) !== key) throw new CopyRefusedError(`${root}'s http backend ${name} ${shownUrl(v)} is not the lock of its state, ${shownUrl(address)}/lock, so its copy's lock could not be named`);
    extra[name] = suffixed;
  }
  return { key, extra };
}

/**
 * The `-backend-config` a root's copy is initialised with, from the backend
 * its code declares with the job's flags over it. Throws
 * {@link CopyRefusedError} for a root no copy can be made of: a `cloud`
 * block, a backend with no key attribute, a block that names no key.
 */
export function copyBackend(dir: string, root: string, suffix: string, env: NodeJS.ProcessEnv = {}, binary?: string): CopyBackend {
  const b = declaredBackend(dir, { env, ...(binary ? { binary } : {}) });
  if (b?.type === "cloud") throw new CopyRefusedError(`${root} keeps its state in HCP Terraform (a cloud block), where a state is a workspace and not a key; a copy is made of roots whose backend is ${BACKENDS}`);
  const type = b?.type ?? "local";
  const attribute = KEY_ATTRIBUTE[type];
  if (!attribute) throw new CopyRefusedError(`${root}'s backend is ${type}, and a copy is given a state key of its own on ${BACKENDS} backends only`);
  const config = b?.config ?? {};
  if (type === "http") {
    const copy = gitlabCopy(root, config, env, suffix);
    return { type, attribute, key: copy.key, location: shownUrl(copy.key), ...(Object.keys(copy.extra).length ? { extra: copy.extra } : {}) };
  }
  const raw = config[attribute];
  const given = typeof raw === "string" && raw !== "" ? raw : type === "local" ? "terraform.tfstate" : undefined;
  if (!given) throw new CopyRefusedError(`${root}'s ${type} backend names no ${attribute}, so there is no key to give its copy a suffix; write the ${attribute} in the block`);
  const key = suffixedKey(given, suffix);
  return { type, attribute, key, location: locationOf(type, config, key) };
}

/**
 * The backend a prepared root was initialised with, checked to be its copy:
 * its key attribute, and a GitLab state's lock addresses, carry the suffix.
 * Throws {@link CopyRefusedError} when it does not; `hint` says how to make
 * the product's config read the suffix.
 */
export function preparedCopyBackend(dir: string, root: string, suffix: string, env: NodeJS.ProcessEnv = {}, hint?: string): CopyBackend {
  const how = hint ? `; ${hint}` : "";
  const b = initialisedBackend(dir, env);
  if (!b) throw new CopyRefusedError(`${root}: it was prepared with no backend the binary recorded, so its copy has no key of its own${how}`);
  const attribute = KEY_ATTRIBUTE[b.type];
  if (!attribute) throw new CopyRefusedError(`${root}'s backend is ${b.type}, and a copy is given a state key of its own on ${BACKENDS} backends only`);
  const raw = b.config[attribute];
  const key = typeof raw === "string" ? raw : "";
  if (b.type === "http" && !isGitLabAddress(key)) throw new CopyRefusedError(`${root}'s http backend ${key ? `address ${shownUrl(key)} is not a GitLab project's state API` : "names no address"}, and a copy of an http backend's state is made on GitLab-managed state only`);
  if (!carriesSuffix(key, suffix)) throw new CopyRefusedError(`${root}: its ${b.type} backend's ${attribute} is ${key ? (b.type === "http" ? shownUrl(key) : key) : "empty"} as it was prepared, which is the root's own state, so its copy is refused${how}`);
  if (b.type === "http") {
    const own = HTTP_LOCK_ATTRIBUTES.map((a) => b.config[a]).find((l): l is string => typeof l === "string" && !carriesSuffix(l, suffix));
    if (own) throw new CopyRefusedError(`${root}: its http backend's lock address is ${shownUrl(own)} as it was prepared, the lock of the root's own state, so its copy is refused; make lock_address and unlock_address read the suffix as the address does`);
  }
  return { type: b.type, attribute, key, location: locationOf(b.type, b.config, key) };
}

/** One root of a copy: where the binary runs it, and how. */
export interface CopyRoot {
  /** The root's name, as the records and the report name it. */
  root: string;
  /** The root's directory in the checkout planned. */
  dir: string;
  binary: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Prepare a root another tool initialises (a Terragrunt unit), with the
   * suffix set as its config reads it: where the binary then runs, and with
   * which env. Its recorded backend must carry the suffix.
   */
  prepare?: (suffix: string) => Promise<{ dir: string; env: NodeJS.ProcessEnv }>;
}

export interface CopyPlanInput {
  copy: CopyRoot;
  /** The environment's suffix: `pr-<n>`. */
  suffix: string;
  /** Where the plan file goes. */
  planFile: string;
  destroy?: boolean;
  lockTimeout?: string | false;
  exec?: BinaryExec;
  /** How the product's config reads the suffix, for a prepared root's refusal. */
  hint?: string;
}

/**
 * Plan one root's copy: init it under its suffixed key (or prepare it, then
 * check its key), plan (a destroy with `destroy`), and read the plan's
 * counts. A run of the binary that fails is the plan's `error`; a root no
 * copy can be made of throws {@link CopyRefusedError}.
 */
export async function terraformCopyPlan(input: CopyPlanInput): Promise<PrEnvComponentPlan> {
  const { copy, suffix } = input;
  const exec = input.exec;
  const none = { component: copy.root, planDigest: "", create: 0, update: 0, replace: 0, delete: 0 };
  let dir = copy.dir;
  let env = copy.env ?? process.env;
  let backend: CopyBackend;
  let backendConfig: Record<string, string> = {};
  if (copy.prepare) {
    let prepared: { dir: string; env: NodeJS.ProcessEnv };
    try {
      prepared = await copy.prepare(suffix);
    } catch (e) {
      return { ...none, error: (e as Error).message, apply: async () => {} };
    }
    ({ dir, env } = prepared);
    backend = preparedCopyBackend(dir, copy.root, suffix, env, input.hint);
  } else {
    backend = copyBackend(dir, copy.root, suffix, env, copy.binary);
    backendConfig = { [backend.attribute]: backend.key, ...backend.extra };
  }
  const run = { root: copy.root, binary: copy.binary, dir, env, ...(exec ? { exec } : {}) };
  try {
    const read = await planCopy({ ...run, backendConfig, planFile: input.planFile, ...(copy.prepare ? { init: false } : {}), ...(input.destroy ? { destroy: true } : {}), ...(input.lockTimeout !== undefined ? { lockTimeout: input.lockTimeout } : {}) });
    const count = (action: string): number => read.part.entries.filter((e) => e.action === action).length;
    return {
      component: copy.root,
      planDigest: read.planDigest,
      create: count("create"),
      update: count("update"),
      replace: count("replace"),
      delete: count("delete"),
      location: backend.location,
      apply: () => applyPlanFile({ ...run, planFile: input.planFile, ...(input.lockTimeout !== undefined ? { lockTimeout: input.lockTimeout } : {}) }),
    };
  } catch (e) {
    return { ...none, location: backend.location, error: (e as Error).message, apply: async () => {} };
  }
}

export interface TerraformPrEnvInput {
  /** The roots of the copy, in apply order, from the pull request's head. */
  roots(target: { pr: number; env: string; head: string }): Promise<CopyRoot[]>;
  /** A directory the plan files go in. */
  work: string;
  exec?: BinaryExec;
  lockTimeout?: string | false;
  hint?: string;
  /** What a copy with no roots says. */
  nothing?: string;
  log?: (line: string) => void;
}

/**
 * The adapter `prEnvUp` takes for a copy of Terraform roots: each root's copy
 * planned under `-<env>` (`pr-<n>`) and applied in order. `refused` holds a
 * {@link CopyRefusedError}, which a product raises as a config error.
 */
export function terraformPrEnvAdapter(input: TerraformPrEnvInput): PrEnvAdapter & { refused?: Error } {
  let copies = new Map<string, CopyRoot>();
  return componentsPrEnvAdapter({
    async components(target) {
      const roots = await input.roots(target);
      copies = new Map(roots.map((r) => [r.root, r]));
      return roots.map((r) => r.root);
    },
    plan: (component, i, target) =>
      terraformCopyPlan({ copy: copies.get(component)!, suffix: target.env, planFile: join(input.work, `${i}.tfplan`), ...(input.exec ? { exec: input.exec } : {}), ...(input.lockTimeout !== undefined ? { lockTimeout: input.lockTimeout } : {}), ...(input.hint ? { hint: input.hint } : {}) }),
    ...(input.nothing ? { nothing: () => input.nothing! } : {}),
    ...(input.log ? { log: input.log } : {}),
  });
}

export interface TerraformPrEnvTeardownInput {
  /** The name outcomes are attributed to: the product's. */
  name: string;
  /**
   * The roots as the commit the copy last applied from has them, with what
   * it holds released by `done`. A root missing from `roots` fails alone.
   */
  checkout(live: LivePrEnvironment): Promise<{ roots: CopyRoot[]; done?: () => void }>;
  work: string;
  exec?: BinaryExec;
  lockTimeout?: string | false;
  hint?: string;
  log?: (line: string) => void;
}

/**
 * The teardown `prEnvDown` and `prEnvSweep` take for a copy of Terraform
 * roots: a root whose recorded state location carries `-<env>` is destroyed,
 * through a planned destroy of its copy, in reverse apply order; any other
 * is a hole, so nothing at a root's own key is destroyed. It stands in for
 * the terraform lexicon's own teardown.
 */
export function terraformPrEnvTeardown(input: TerraformPrEnvTeardownInput): PrEnvTeardownAdapter {
  return componentsPrEnvTeardown({
    name: input.name,
    lexicons: ["terraform"],
    type: "terraform_root",
    owns: (location, env) => carriesSuffix(location, env),
    async checkout(live) {
      const code = await input.checkout(live);
      const roots = new Map(code.roots.map((r) => [r.root, r]));
      return {
        async plan(component, i) {
          const copy = roots.get(component);
          if (!copy) throw new Error(`${component} is not at ${live.commit.slice(0, 8)}, so its copy cannot be planned`);
          return terraformCopyPlan({ copy, suffix: live.env, planFile: join(input.work, `destroy-${i}.tfplan`), destroy: true, ...(input.exec ? { exec: input.exec } : {}), ...(input.lockTimeout !== undefined ? { lockTimeout: input.lockTimeout } : {}), ...(input.hint ? { hint: input.hint } : {}) });
        },
        ...(code.done ? { done: code.done } : {}),
      };
    },
    ...(input.log ? { log: input.log } : {}),
  });
}
