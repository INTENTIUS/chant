/**
 * Config and secret sets per environment (#5348): one declared set per
 * environment, which the jobs of that environment's stage receive.
 *
 * A stage applies the same code in each environment with that
 * environment's config and secrets. The declaration keys a set by
 * environment name, as a step's `environments` map is keyed (#5360,
 * ./step-environments.ts), and shared sets sit beside them under
 * `configSets`:
 *
 *     {
 *       configSets: {
 *         common: { config: { LOG_LEVEL: "info" } },
 *       },
 *       environments: {
 *         staging: {
 *           imports: ["common"],
 *           config: { REGION: "us-east-2" },
 *           secrets: {
 *             DB_PASSWORD: "STAGING_DB_PASSWORD",
 *             API_KEY: { awsSecretsManager: "arn:aws:secretsmanager:us-east-2:111111111111:secret:staging/api", jsonKey: "key" },
 *           },
 *         },
 *         prod: { imports: ["common"], config: { REGION: "us-east-1" }, secrets: { DB_PASSWORD: "PROD_DB_PASSWORD" } },
 *       },
 *     }
 *
 * `config` holds plain values. `secrets` holds where each secret is kept,
 * never the secret: a forge secret's name (a string, or `{ forgeSecret }`),
 * an AWS Secrets Manager secret, a Google Secret Manager version or an
 * Azure Key Vault secret. A job reads a store's secret with the cloud
 * identity it logged in as, the one `ci.identity` gives that stage
 * (../ci-identity.ts, ../ci-login.ts), so a staging job can read only what
 * the staging identity may.
 *
 * {@link resolveEnvironmentSet} picks the environment's entry with
 * `environmentEntryName`, the lookup a step's `environments` uses: the
 * environment's own entry, or for a pull request environment `pr-<n>` its
 * template's. An environment the sets do not name is refused, naming the
 * ones they do. A set's `imports` name shared sets, applied in order, and
 * the set's own values then replace theirs. An environment's set imports
 * shared sets alone, never another environment's, so one stage's set never
 * carries another stage's secrets. Each value keeps the set it came from
 * and the imports that led there.
 *
 * {@link environmentSetJobInputs} is what a generator hands a stage's jobs:
 * the config as variables, the forge secrets as passed secrets, the lines
 * that read the store secrets after the login, and {@link ENV_SET_ENV}, the
 * set's record of names and sources, which holds no secret. `chant ci run`
 * reads the record and redacts each secret variable's value from the run's
 * events, record and report, whatever its name (../workspace/ci-secrets.ts).
 *
 * This module imports only the step environments and the release floors at
 * run time.
 */

import { NEXT_RELEASE } from "../release-floors";
import { environmentEntryName, type StepEnvironmentOptions } from "./step-environments";

/**
 * The first chant with config and secret sets per environment (#5348):
 * `resolveEnvironmentSet`, `environmentSetJobInputs`, `environmentSets` on
 * the Op waves generators, the pipeline's generator and the pull request
 * loop, which hand each stage's jobs the set of their environment,
 * `ci.environmentSets` in the workspace declaration, each stage's own
 * identity on a pipeline's promote jobs, and `chant ci run`'s redaction of
 * each secret the set names.
 */
export const ENVIRONMENT_SETS_FLOOR = NEXT_RELEASE;

/** The job variable holding the set's record (#5348), as JSON: names and sources, never a secret. */
export const ENV_SET_ENV = "CHANT_ENV_SET";

/** The variable the store read takes its list from, as JSON: names and where each is kept. */
export const ENV_SET_FETCH_ENV = "CHANT_ENV_SET_FETCH";

/** The shell variable the store read's `export` lines sit in until the shell evaluates them. Not exported. */
const ENV_SET_VARS = "CHANT_ENV_SET_VARS";

/** The schema of {@link EnvironmentSetRecord}. */
export const ENV_SET_SCHEMA = "chant.environment-set/v1";

/**
 * Where one secret is kept. A string is a forge secret's name (a GitLab
 * CI/CD variable's on GitLab).
 */
export type EnvironmentSecretRef =
  | string
  | { forgeSecret: string }
  /** A Secrets Manager secret's ARN or name; `jsonKey` picks one key of a JSON secret. Default region: the job's. */
  | { awsSecretsManager: string; jsonKey?: string; region?: string }
  /** `projects/<project>/secrets/<secret>`, with `/versions/<version>` or the latest. */
  | { gcpSecretManager: string }
  /** The secret's URL, `https://<vault>.vault.azure.net/secrets/<name>`, with `/<version>` or the latest. */
  | { azureKeyVault: string };

/** One set: the shared sets it imports, its plain values and its secrets. */
export interface EnvironmentSet {
  /** Shared sets (`configSets` keys) applied first, in order; this set's own values replace theirs. */
  imports?: string[];
  /** Plain values, by variable name. */
  config?: Record<string, string>;
  /** Secrets, by variable name: where each is kept. */
  secrets?: Record<string, EnvironmentSecretRef>;
}

/** Every set: one per environment, and the shared ones they import. */
export interface EnvironmentSets {
  /** One set per environment, keyed by environment name (product key `environments.<name>`). */
  environments: Record<string, EnvironmentSet>;
  /** Shared sets, keyed by name (product key `config_sets.<set>`). */
  configSets?: Record<string, EnvironmentSet>;
}

/** Where a resolved secret is kept. */
export type EnvironmentSecretSource =
  | { store: "forge"; secret: string }
  | { store: "aws-secrets-manager"; id: string; jsonKey?: string; region?: string }
  | { store: "gcp-secret-manager"; name: string }
  | { store: "azure-key-vault"; id: string };

/** What every resolved value records of where it came from. */
export interface EnvironmentSetOrigin {
  /** The variable. */
  name: string;
  /** The set that gives the value: the environment's entry, or a `configSets` key. */
  from: string;
  /** The sets from the environment's entry to `from`, first to last; `[from]` when the entry gives it. */
  via: string[];
}

export interface EnvironmentConfigValue extends EnvironmentSetOrigin {
  kind: "config";
  value: string;
}

export interface EnvironmentSecretValue extends EnvironmentSetOrigin {
  kind: "secret";
  source: EnvironmentSecretSource;
}

/** One environment's set, resolved: every value once, in name order. */
export interface ResolvedEnvironmentSet {
  /** The environment the set was resolved for. */
  env: string;
  /** The `environments` entry it took: `env`, or a pull request environment's template. */
  entry: string;
  config: EnvironmentConfigValue[];
  secrets: EnvironmentSecretValue[];
}

/** The set's record (#5348): each variable, its kind and where it came from. A secret's value is never in it. */
export interface EnvironmentSetRecord {
  schema: typeof ENV_SET_SCHEMA;
  env: string;
  entry: string;
  values: Array<EnvironmentSetOrigin & ({ kind: "config"; value: string } | { kind: "secret"; source: EnvironmentSecretSource })>;
}

export class EnvironmentSetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvironmentSetError";
  }
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const GCP_SECRET = /^projects\/[^/\s]+\/secrets\/[^/\s]+(\/versions\/[^/\s]+)?$/;
const AZURE_SECRET = /^https:\/\/[^/\s]+\/secrets\/[^/\s]+(\/[^/\s]+)?$/;
const isMap = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The variable names a set refuses: chant's own, which the jobs set themselves. */
const isReserved = (name: string): boolean => name.startsWith("CHANT_");

/** Where `ref` is kept, or why it names no store. */
function sourceOf(ref: unknown): EnvironmentSecretSource | string {
  if (typeof ref === "string") return NAME.test(ref) ? { store: "forge", secret: ref } : `names the forge secret ${JSON.stringify(ref)}, which is not a secret name`;
  if (!isMap(ref)) return "takes a forge secret's name, or a map naming where the secret is kept";
  const stores = ["forgeSecret", "awsSecretsManager", "gcpSecretManager", "azureKeyVault"].filter((k) => k in ref);
  if (stores.length !== 1) return "names one of forgeSecret, awsSecretsManager, gcpSecretManager and azureKeyVault";
  const extra = Object.keys(ref).filter((k) => k !== stores[0] && !(stores[0] === "awsSecretsManager" && (k === "jsonKey" || k === "region")));
  if (extra.length > 0) return `sets ${extra.join(", ")} beside ${stores[0]}`;
  const at = ref[stores[0]!];
  if (typeof at !== "string" || at.trim() === "") return `sets ${stores[0]} to something other than a name`;
  switch (stores[0]) {
    case "forgeSecret":
      return NAME.test(at) ? { store: "forge", secret: at } : `names the forge secret ${JSON.stringify(at)}, which is not a secret name`;
    case "awsSecretsManager": {
      if (/\s/.test(at)) return `names the Secrets Manager secret ${JSON.stringify(at)}, with a space in it`;
      if (ref.jsonKey !== undefined && (typeof ref.jsonKey !== "string" || ref.jsonKey === "")) return "sets jsonKey to something other than a key";
      if (ref.region !== undefined && (typeof ref.region !== "string" || !/^[a-z0-9-]+$/.test(ref.region))) return "sets region to something other than a region";
      return { store: "aws-secrets-manager", id: at, ...(ref.jsonKey !== undefined ? { jsonKey: ref.jsonKey as string } : {}), ...(ref.region !== undefined ? { region: ref.region as string } : {}) };
    }
    case "gcpSecretManager":
      return GCP_SECRET.test(at) ? { store: "gcp-secret-manager", name: at } : `names ${JSON.stringify(at)}, where it takes projects/<project>/secrets/<secret>, with /versions/<version> or the latest`;
    default:
      return AZURE_SECRET.test(at) ? { store: "azure-key-vault", id: at } : `names ${JSON.stringify(at)}, where it takes the secret's URL, https://<vault>.vault.azure.net/secrets/<name>`;
  }
}

/** Every problem of one set, each a sentence about `where`. */
function setProblems(where: string, set: unknown, sets: EnvironmentSets): string[] {
  if (!isMap(set)) return [`${where} is a map of imports, config and secrets`];
  const out: string[] = [];
  for (const key of Object.keys(set)) if (!["imports", "config", "secrets"].includes(key)) out.push(`${where} sets ${key}, where a set takes imports, config and secrets`);
  if (set.imports !== undefined) {
    if (!Array.isArray(set.imports) || set.imports.some((i) => typeof i !== "string")) out.push(`${where}'s imports is a list of shared set names`);
    else
      for (const name of set.imports as string[]) {
        if (Object.prototype.hasOwnProperty.call(sets.configSets ?? {}, name)) continue;
        out.push(
          Object.prototype.hasOwnProperty.call(sets.environments, name)
            ? `${where} imports ${name}, an environment's set; a set imports shared sets (configSets) alone, so one stage never holds another's values`
            : `${where} imports ${name}, which configSets does not declare`,
        );
      }
  }
  const names = new Set<string>();
  for (const part of ["config", "secrets"] as const) {
    const map = set[part];
    if (map === undefined) continue;
    if (!isMap(map)) {
      out.push(`${where}'s ${part} is a map of variable name to ${part === "config" ? "value" : "where the secret is kept"}`);
      continue;
    }
    for (const [name, value] of Object.entries(map)) {
      if (!NAME.test(name)) out.push(`${where}'s ${part} names ${JSON.stringify(name)}, which is not a variable name`);
      else if (isReserved(name)) out.push(`${where}'s ${part} names ${name}; a variable starting CHANT_ is one chant's jobs set themselves`);
      if (names.has(name)) out.push(`${where} sets ${name} in both config and secrets; give it once`);
      names.add(name);
      if (part === "config" && typeof value !== "string") out.push(`${where}'s config sets ${name} to something other than a string`);
      if (part === "secrets") {
        const source = sourceOf(value);
        if (typeof source === "string") out.push(`${where}'s secret ${name} ${source}`);
      }
    }
  }
  return out;
}

/** Every problem of `sets`: shapes, names, references and imports, cycles included. Empty when the sets resolve. */
export function environmentSetsProblems(sets: EnvironmentSets): string[] {
  if (!isMap(sets) || !isMap(sets.environments)) return ["the sets take environments, a map of environment name to its set"];
  if (sets.configSets !== undefined && !isMap(sets.configSets)) return ["configSets is a map of shared set name to its set"];
  const out: string[] = [];
  for (const [name, set] of Object.entries(sets.configSets ?? {})) {
    if (!SET_NAME.test(name)) out.push(`the shared set ${JSON.stringify(name)} needs a name of letters, digits, '.', '_' and '-'`);
    out.push(...setProblems(`the shared set ${name}`, set, sets));
  }
  for (const [env, set] of Object.entries(sets.environments)) out.push(...setProblems(`the set of ${env}`, set, sets));
  if (out.length > 0) return out;
  // A cycle of imports among the shared sets.
  const state = new Map<string, "open" | "done">();
  const visit = (name: string, path: string[]): void => {
    if (state.get(name) === "done") return;
    if (state.get(name) === "open") {
      out.push(`the shared sets import each other: ${[...path.slice(path.indexOf(name)), name].join(" -> ")}`);
      return;
    }
    state.set(name, "open");
    for (const next of sets.configSets?.[name]?.imports ?? []) visit(next, [...path, name]);
    state.set(name, "done");
  };
  for (const name of Object.keys(sets.configSets ?? {})) visit(name, []);
  return out;
}

/**
 * `env`'s set, resolved: its entry's imports in order, each with its own
 * imports first, then the entry's own values, a later value replacing an
 * earlier one of the same name. Each value records the set it came from and
 * the imports that led there. Throws an {@link EnvironmentSetError} when
 * the sets have a problem or do not name `env` (nor, for `pr-<n>`, its
 * template), naming the environments they do.
 */
export function resolveEnvironmentSet(sets: EnvironmentSets, env: string, options: StepEnvironmentOptions = {}): ResolvedEnvironmentSet {
  const problems = environmentSetsProblems(sets);
  if (problems.length > 0) throw new EnvironmentSetError(problems.join("\n"));
  const entry = environmentEntryName(sets.environments, env, options);
  if (entry === undefined) {
    throw new EnvironmentSetError(`the config and secret sets name ${Object.keys(sets.environments).join(", ") || "no environment"}, and not ${env}`);
  }
  const values = new Map<string, EnvironmentConfigValue | EnvironmentSecretValue>();
  const apply = (set: EnvironmentSet, from: string, via: string[]): void => {
    for (const name of set.imports ?? []) apply(sets.configSets![name]!, name, [...via, name]);
    for (const [name, value] of Object.entries(set.config ?? {})) values.set(name, { kind: "config", name, value, from, via });
    for (const [name, ref] of Object.entries(set.secrets ?? {})) values.set(name, { kind: "secret", name, source: sourceOf(ref) as EnvironmentSecretSource, from, via });
  };
  apply(sets.environments[entry]!, entry, [entry]);
  const sorted = [...values.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    env,
    entry,
    config: sorted.filter((v): v is EnvironmentConfigValue => v.kind === "config"),
    secrets: sorted.filter((v): v is EnvironmentSecretValue => v.kind === "secret"),
  };
}

/** The set's record: every variable with its kind and origin, a config value with its value, a secret with where it is kept. */
export function environmentSetRecord(set: ResolvedEnvironmentSet): EnvironmentSetRecord {
  const values = [...set.config, ...set.secrets]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((v) => (v.kind === "config" ? { name: v.name, kind: v.kind, value: v.value, from: v.from, via: v.via } : { name: v.name, kind: v.kind, source: v.source, from: v.from, via: v.via }));
  return { schema: ENV_SET_SCHEMA, env: set.env, entry: set.entry, values };
}

/**
 * The secret variables the set in `env` names, from its record in
 * {@link ENV_SET_ENV}. Empty when the variable is absent or not a record.
 * `chant ci run` redacts each one's value, whatever its name.
 */
export function environmentSetSecretNames(env: Record<string, string | undefined>): string[] {
  const text = env[ENV_SET_ENV];
  if (!text) return [];
  try {
    const record = JSON.parse(text) as Partial<EnvironmentSetRecord>;
    if (record.schema !== ENV_SET_SCHEMA || !Array.isArray(record.values)) return [];
    return record.values.filter((v) => v && v.kind === "secret" && typeof v.name === "string" && NAME.test(v.name)).map((v) => v.name);
  } catch {
    return [];
  }
}

/** The forges a stage's jobs are rendered for. */
export type EnvironmentSetForge = "github" | "gitlab" | "forgejo";

/** What a generator hands one stage's jobs (#5348). */
export interface EnvironmentSetJobInputs {
  /** The config values and {@link ENV_SET_ENV}, by variable name, as the pull request loop's `variables` take them. */
  variables: Record<string, string>;
  /** The forge secrets, as `{ <variable>: <secret> }`, as the pull request loop's `secrets` take them. Empty with `secrets: false`. */
  secrets: Record<string, string>;
  /**
   * Shell lines that read the store secrets and export them, run in the
   * step of the job's command after the job logged in. Empty when the set
   * keeps no secret in a store, or with `secrets: false`.
   */
  setup: string[];
}

/**
 * The store read, a script for `node -e` with no dependency. argv 1 is the
 * forge: on `github` and `forgejo` it also prints a `::add-mask::` line
 * per line of each value, which the runner takes and never shows. It
 * prints `export` lines for the shell to evaluate, and never a value on its
 * own. A failed read names the variable and where it is kept.
 */
export const ENV_SET_FETCH_JS = [
  'const cp=require("child_process");',
  "const forge=process.argv[1];",
  "const Q=String.fromCharCode(39);",
  'const q=(v)=>Q+String(v).split(Q).join(Q+"\\\\"+Q+Q)+Q;',
  'const fail=(m)=>{console.error("chant: the environment set\\u0027s secrets could not be read: "+m);process.exit(1)};',
  `let list;try{list=JSON.parse(process.env.${ENV_SET_FETCH_ENV}||"")}catch{fail("${ENV_SET_FETCH_ENV} is not JSON")}`,
  'if(!Array.isArray(list))fail("' + ENV_SET_FETCH_ENV + ' is not a list");',
  'const call=(at,cmd,args)=>{const r=cp.spawnSync(cmd,args,{encoding:"utf8",stdio:["ignore","pipe","pipe"],maxBuffer:1<<26});',
  'if(r.error)fail(at+": "+cmd+" could not run: "+r.error.message);',
  'if(r.status!==0)fail(at+": "+cmd+" exited "+r.status+(r.stderr&&r.stderr.trim()?": "+r.stderr.trim().split("\\n").pop():""));',
  "return r.stdout};",
  'const chomp=(v)=>v.endsWith("\\r\\n")?v.slice(0,-2):v.endsWith("\\n")?v.slice(0,-1):v;',
  'const read=(e)=>{const s=e.source,at=e.name+" ("+s.store+" "+(s.id||s.name)+")";',
  'if(s.store==="aws-secrets-manager"){let v=chomp(call(at,"aws",["secretsmanager","get-secret-value","--secret-id",s.id,"--query","SecretString","--output","text",...(s.region?["--region",s.region]:[])]));',
  'if(s.jsonKey!==undefined){let d;try{d=JSON.parse(v)}catch{fail(at+": the secret is not JSON, and jsonKey reads a key of a JSON secret")}',
  'if(!d||typeof d!=="object"||!(s.jsonKey in d))fail(at+": the secret has no key "+s.jsonKey);v=typeof d[s.jsonKey]==="string"?d[s.jsonKey]:JSON.stringify(d[s.jsonKey])}return v}',
  'if(s.store==="gcp-secret-manager"){const m=/^projects\\/([^/]+)\\/secrets\\/([^/]+)(?:\\/versions\\/([^/]+))?$/.exec(s.name);if(!m)fail(at+": not a secret version");',
  'return call(at,"gcloud",["secrets","versions","access",m[3]||"latest","--secret="+m[2],"--project="+m[1]])}',
  'if(s.store==="azure-key-vault")return chomp(call(at,"az",["keyvault","secret","show","--id",s.id,"--query","value","--output","tsv"]));',
  'fail(at+": not a store chant reads")};',
  'let out="";',
  "for(const e of list){",
  'if(!e||typeof e.name!=="string"||!/^[A-Za-z_][A-Za-z0-9_]*$/.test(e.name)||!e.source)fail("an entry names no variable");',
  "const v=read(e);",
  'if(forge!=="gitlab")for(const l of v.split(/\\r?\\n/))if(l.trim())out+="printf "+q("%s\\\\n")+" "+q("::add-mask::"+l)+"\\n";',
  'out+="export "+e.name+"="+q(v)+"\\n";',
  'console.error("chant: read "+e.name+" from "+e.source.store)}',
  "process.stdout.write(out);",
].join("");

const sh = (s: string): string => `'${s.split("'").join(`'\\''`)}'`;

/**
 * The shell lines that read the store secrets of `set` and export them in
 * the shell that runs them, then unset what held them. An assignment's
 * status is its command substitution's, so a failed read stops the job.
 */
export function environmentSetFetchLines(set: ResolvedEnvironmentSet, forge: EnvironmentSetForge): string[] {
  const list = set.secrets.filter((s) => s.source.store !== "forge").map((s) => ({ name: s.name, source: s.source }));
  if (list.length === 0) return [];
  return [
    `export ${ENV_SET_FETCH_ENV}=${sh(JSON.stringify(list))}`,
    `${ENV_SET_VARS}="$(cd / && node -e '${ENV_SET_FETCH_JS}' ${forge})" || exit 1`,
    `eval "$${ENV_SET_VARS}"`,
    `unset ${ENV_SET_VARS} ${ENV_SET_FETCH_ENV}`,
  ];
}

/**
 * What a generator hands the jobs of `set`'s stage: the config as
 * variables, the forge secrets as passed secrets, the store read as setup
 * lines, and the record as {@link ENV_SET_ENV}. With `secrets: false`, for
 * a job that runs a pull request's code, the config and the record alone.
 */
export function environmentSetJobInputs(set: ResolvedEnvironmentSet, forge: EnvironmentSetForge, options: { secrets?: boolean } = {}): EnvironmentSetJobInputs {
  const withSecrets = options.secrets !== false;
  const variables: Record<string, string> = Object.fromEntries(set.config.map((c) => [c.name, c.value]));
  variables[ENV_SET_ENV] = JSON.stringify(environmentSetRecord(set));
  const secrets: Record<string, string> = withSecrets
    ? Object.fromEntries(set.secrets.flatMap((s) => (s.source.store === "forge" ? [[s.name, s.source.secret]] : [])))
    : {};
  return { variables, secrets, setup: withSecrets ? environmentSetFetchLines(set, forge) : [] };
}
