import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { z } from "zod";
import type { LintConfig } from "./lint/config";
import type { OwnershipMarker } from "./ownership";
import { DEFAULT_SBOM_FORMAT, type SbomFormat } from "./components/verbs/sbom-generator";
import type { Severity } from "./components/verbs/vuln-scan";
import type { VulnPolicy } from "./components/verbs/vuln-gate";
import type { BuildParamsConfig } from "./build-params";
import type { BuildParamProvenance } from "./provenance";
import { findProjectConfig } from "./project-root";
import { evaluateProjectConfig } from "./config-sandbox";

/**
 * One project-declared environment (chant #1166). Historically always a bare
 * name (`"floci"`); an entry can now instead carry the endpoint that
 * environment's `--live` reads should target (`{ name: "floci", endpoint:
 * "http://localhost:4566" }`), so a project pointed at a local emulator is
 * self-sufficient — no ambient `AWS_ENDPOINT_URL` export required to avoid
 * silently querying real AWS. See {@link environmentName}, {@link
 * environmentNames}, {@link environmentEndpoint} below, and
 * `./live-endpoint.ts`'s `applyLiveEndpoint`, the CLI-side consumer.
 */
export type EnvironmentDeclaration = string | { name: string; endpoint?: string };

/**
 * `ownership.env`: a literal environment identity, or a reference to a
 * declared build parameter whose resolved value becomes the identity (#1396).
 */
export type OwnershipEnv = string | { param: string };

/** The declared name of one `environments` entry, whichever form it takes. */
export function environmentName(entry: EnvironmentDeclaration): string {
  return typeof entry === "string" ? entry : entry.name;
}

/**
 * Every declared environment's name, in `environments` order. `undefined` in,
 * `undefined` out — mirrors the field itself being optional, so a caller that
 * already writes `config.environments?.something` can keep doing so:
 * `environmentNames(config.environments)?.includes(name)`.
 */
export function environmentNames(environments: EnvironmentDeclaration[] | undefined): string[] | undefined {
  return environments?.map(environmentName);
}

/**
 * Whether a declared environment name is a glob pattern rather than a literal
 * (#1221) — it contains at least one `*`.
 */
export function isEnvironmentPattern(declaredName: string): boolean {
  return declaredName.includes("*");
}

/**
 * Anchored `*`-glob match (#1221): each `*` in `pattern` matches any run of
 * characters (possibly empty); everything else matches itself. Deliberately
 * the whole surface — no `?`, no character classes, no regex. A pattern with
 * no `*` degenerates to string equality.
 */
export function matchesEnvironmentPattern(pattern: string, name: string): boolean {
  const parts = pattern.split("*");
  if (parts.length === 1) return pattern === name;
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (!name.startsWith(first)) return false;
  let cursor = first.length;
  for (let i = 1; i < parts.length - 1; i++) {
    const part = parts[i];
    if (part === "") continue;
    const at = name.indexOf(part, cursor);
    if (at === -1) return false;
    cursor = at + part.length;
  }
  return name.length - cursor >= last.length && name.endsWith(last);
}

/**
 * Environment-membership test (#1221): is `name` covered by this project's
 * declared `environments`? A literal entry matches by equality; an entry
 * containing `*` matches as a glob pattern (`"pr-*"` covers `pr-42`).
 * Literals are checked first across the whole list, then patterns — so a
 * name that is declared outright never depends on pattern order. `undefined`
 * / empty `environments` returns `false`; callers that treat "no declared
 * environments" as "anything goes" (e.g. {@link unknownEnvError} in
 * `./env.ts`) guard that case themselves.
 */
export function matchesDeclaredEnvironment(
  environments: EnvironmentDeclaration[] | undefined,
  name: string,
): boolean {
  const names = environmentNames(environments) ?? [];
  if (names.includes(name)) return true;
  return names.some((declared) => isEnvironmentPattern(declared) && matchesEnvironmentPattern(declared, name));
}

/**
 * The endpoint `name` declares (chant #1166) — `undefined` for a bare-string
 * entry, an entry with no `endpoint` set, or a name this project doesn't
 * declare at all. `./live-endpoint.ts`'s `applyLiveEndpoint` is the consumer:
 * it injects this into the ambient env var each observing lexicon's CLI
 * shell-out reads (e.g. `AWS_ENDPOINT_URL`), unless that var is already set —
 * ambient always wins.
 *
 * A pattern entry (#1221) can carry an endpoint too: `{ name: "pr-*",
 * endpoint }` supplies the endpoint for every `pr-<n>` environment. A literal
 * entry always wins over a pattern — declaring `pr-special` alongside
 * `pr-*` resolves `pr-special` to the literal entry's endpoint (or none).
 */
export function environmentEndpoint(environments: EnvironmentDeclaration[] | undefined, name: string): string | undefined {
  const found =
    environments?.find((e) => environmentName(e) === name) ??
    environments?.find((e) => isEnvironmentPattern(environmentName(e)) && matchesEnvironmentPattern(environmentName(e), name));
  return found && typeof found !== "string" ? found.endpoint : undefined;
}

/**
 * Zod schema for ChantConfig validation.
 */
const EnvironmentEntrySchema = z.union([
  z.string().min(1),
  z.object({
    name: z.string().min(1),
    endpoint: z.string().min(1).optional(),
  }),
]);

export const ChantConfigSchema = z.object({
  lexicons: z.array(z.string().min(1)).optional(),
  capabilities: z.array(z.string().min(1)).optional(),
  environments: z.array(EnvironmentEntrySchema).optional(),
  sourceDir: z.string().min(1).optional(),
  lint: z.record(z.string(), z.unknown()).optional(),
  ownership: z.object({
    stack: z.string().min(1).optional(),
    env: z.union([z.string().min(1), z.object({ param: z.string().min(1) })]).optional(),
    enabled: z.boolean().optional(),
  }).optional(),
  build: z.object({
    fold: z.boolean().optional(),
  }).optional(),
  buildParams: z.record(
    z.string(),
    z.object({
      type: z.enum(["string", "number", "boolean"]),
      default: z.union([z.string(), z.number(), z.boolean()]).optional(),
      enum: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
      env: z.string().min(1).optional(),
      required: z.boolean().optional(),
      description: z.string().optional(),
    }),
  ).optional(),
  release: z.object({
    autoRecord: z.boolean().optional(),
  }).optional(),
  sbom: z.object({
    format: z.enum(["spdx", "cyclonedx"]).optional(),
    enabled: z.boolean().optional(),
  }).optional(),
  signing: z.object({
    keyless: z.boolean().optional(),
    oidcIssuer: z.string().min(1).optional(),
    identity: z.string().min(1).optional(),
    identityIsRegexp: z.boolean().optional(),
    key: z.string().min(1).optional(),
  }).optional(),
  vulnPolicy: z.object({
    failSeverity: z.enum(["critical", "high", "medium", "low", "negligible", "unknown"]).optional(),
    fixableOnly: z.boolean().optional(),
    warnSeverity: z.enum(["critical", "high", "medium", "low", "negligible", "unknown"]).optional(),
    failOnLicense: z.boolean().optional(),
    failOnUnknownSeverity: z.boolean().optional(),
    failOnKev: z.boolean().optional(),
    failEpssAtOrAbove: z.number().min(0).max(1).optional(),
    warnEpssAtOrAbove: z.number().min(0).max(1).optional(),
    exploitabilityFixableOnly: z.boolean().optional(),
    license: z.object({
      allow: z.array(z.string()).optional(),
      deny: z.array(z.string()).optional(),
    }).optional(),
    scanner: z.enum(["grype", "trivy"]).optional(),
    vexSources: z.array(z.string()).optional(),
  }).optional(),
}).passthrough();

/**
 * Top-level chant project configuration.
 *
 * Loaded from `chant.config.ts` (preferred) or `chant.config.json`.
 */
export interface ChantConfig {
  /** Lexicon package names to load (e.g. ["aws"]) */
  lexicons?: string[];

  /**
   * Capability plugin package names to load in addition to the built-in
   * starter set (e.g. ["acme"] loads `@intentius/chant-capability-acme`),
   * mirroring `lexicons` — see {@link CapabilityPlugin} in
   * `./components/capability-plugin.ts` and `buildCapabilityRegistry` in
   * `./components/capability-plugin-loader.ts` (#559, epic #551). The
   * built-in starter verb set (`./components/starter-plugin.ts`) is always
   * loaded regardless of this field.
   */
  capabilities?: string[];

  /**
   * Declared environments (e.g. `["staging", "prod"]`). An entry is either a
   * bare name (unchanged since always) or `{ name, endpoint }` (#1166) when
   * that environment's `--live` reads should target a specific endpoint —
   * a local emulator like Floci (`{ name: "floci", endpoint:
   * "http://localhost:4566" }`) chief among them. See {@link
   * environmentEndpoint} and `./live-endpoint.ts`'s `applyLiveEndpoint`, which
   * injects the declared endpoint into the ambient env var each observing
   * lexicon's CLI shell-out reads (e.g. `AWS_ENDPOINT_URL`) — unless that var
   * is already set, in which case the ambient value always wins.
   */
  environments?: EnvironmentDeclaration[];

  /**
   * Directory (relative to the project root) that holds the chant infrastructure
   * source. Lifecycle commands (`snapshot`/`diff`/`plan`) build from here instead
   * of the project root, so a mixed-layout project — chant `src/` alongside app
   * code that has import side effects — can scope the build to just the infra.
   * Defaults to "." (the project root). The `--src` flag overrides it.
   */
  sourceDir?: string;

  /**
   * Multi-stack projects: the independently-deployed CloudFormation stacks this
   * project comprises, each built from its own source directory. When set,
   * lifecycle commands (`snapshot`/`diff`) iterate every stack — building each
   * `src` scoped (so its logical ids match what that stack actually deploys) and
   * observing it against its own live stack `name` — instead of assuming one
   * stack per environment. Leave unset for a single-stack project (the default:
   * one build from `sourceDir`/root, observed as the stack named after the
   * environment). See {@link resolveStackTargets}.
   */
  stacks?: Array<{
    /** The deployed CloudFormation stack name (what `cfn-deploy` targets). */
    name: string;
    /** Source directory to build for this stack, relative to the project root. */
    src: string;
    /** AWS region this stack is deployed in (multi-region estates). When set,
     * observation/enrichment target this region instead of the ambient one. */
    region?: string;
  }>;

  /** Lint configuration (rules, extends, overrides, plugins) */
  lint?: LintConfig;

  /**
   * Opt-in cloud-side ownership marking. When `stack` is set (and `enabled`
   * is not false), the serializer stamps a chant ownership marker carrying
   * this stack/env identity onto every supported resource. See {@link
   * resolveOwnershipMarker}.
   */
  ownership?: {
    /** Stack identity stamped onto resources (required to enable stamping). */
    stack?: string;
    /**
     * Optional environment identity. Either a literal, or a reference to one
     * of this project's declared `buildParams` (`{ param: "env" }`), in which
     * case the marker takes whatever value that parameter resolves to for the
     * build — the same value `params.env` reads in source (#1396). A
     * reference is the only way to make the marker follow `--param env=prod`:
     * the config is evaluated before build parameters exist, so a literal
     * computed from `process.env` here and a parameter mapped to the same
     * variable are two sources of truth that nothing keeps in step.
     */
    env?: OwnershipEnv;
    /** Set false to disable stamping even when `stack` is present. */
    enabled?: boolean;
  };

  /**
   * `chant build` behavior toggles (#1022, epic #1019).
   */
  build?: {
    /**
     * Fold source modules statically instead of importing/running them,
     * falling back to run per-file for anything the folder can't represent.
     * DEFAULT `true` since chant #1134 — set `false` to make this project
     * run every module (the pre-#1134 behavior). The `--fold`/`--no-fold`
     * CLI flags override this per-invocation in either direction. See
     * {@link resolveFoldEnabled}.
     */
    fold?: boolean;

    /**
     * chant #1045 Phase 2 — opt-in: run-fallback source files (or, when
     * `fold` above isn't set, every file) execute together, isolated, in one
     * sandboxed child process instead of in-process. Default `false`. The
     * `--sandbox` CLI flag overrides this per-invocation (a flag of `true`
     * always wins; the flag cannot force sandboxing *off* when this is
     * `true`). See {@link resolveSandboxEnabled}.
     */
    sandbox?: boolean;
  };

  /**
   * Build-time parameters (#1064) — values supplied to `chant build` (a
   * `--param name=value` flag, a `--params-file` JSON file, or a declared
   * `env` var mapping) and bound to `params.<name>` (`@intentius/chant/params`)
   * for source to reference, instead of reading `process.env` at module
   * scope. Distinct from the deploy-time `Parameter` class
   * (`lexicons/aws/src/parameter.ts`, a CloudFormation `Parameters:` entry
   * that resolves at stack deploy) — a build-time parameter resolves before
   * the template is even synthesized, so it can change which resources are
   * produced at all (e.g. a tier selecting `light` vs `production`). See
   * {@link resolveBuildParams} in `./build-params.ts`.
   */
  buildParams?: BuildParamsConfig;

  /**
   * Release-ledger recording behavior (#597, epic #551). Auto-emitting a
   * release record on a successful `chant run --components <name> --env
   * <env>` deploy is ON by default — this is opt-**out**, not opt-in, per
   * #597's "populate the ledger by construction." See {@link
   * resolveAutoReleaseDisabled}.
   */
  release?: {
    /** Set false to disable auto-emitting a release record after a successful component deploy project-wide. The `--no-release-record` CLI flag overrides this per-invocation. */
    autoRecord?: boolean;
  };

  /**
   * Project-wide SBOM generation defaults (#606, epic #551 follow-up to
   * #564/#568). Consumed by the `generate-sbom` capability
   * (./components/verbs/sbom.ts) via {@link resolveSbomFormat} — a
   * component's own `build.sbom.format` (see `BuildSpec` in
   * ./components/component.ts) always wins over this project default when
   * set, mirroring how `ownership`/`release` are project-wide defaults a
   * more specific caller can override.
   */
  sbom?: {
    /** Default SBOM format for every `generate-sbom` step that doesn't specify its own. Defaults to `DEFAULT_SBOM_FORMAT` ("spdx", see ./components/verbs/sbom-generator.ts) when unset — BuildKit natively emits SPDX attestations for images. */
    format?: SbomFormat;
    /** Set false to opt this project out of SBOM generation entirely — components composing a `generate-sbom` step still run it explicitly, but this is the project-wide switch a component author can point to when deciding whether to include the step at all. Purely advisory: `generate-sbom` has no implicit/automatic invocation to suppress (a component's composition always decides), so this flag has no effect unless a component's own authoring code reads it. */
    enabled?: boolean;
  };

  /**
   * Project-wide signing/verification defaults (#622, epic #551 follow-up to
   * #614's reproducibility/provenance material). Consumed by
   * `./components/verbs/sign.ts`'s `sign`/`attest-provenance` capabilities and
   * `./components/verbs/verify.ts`'s `verify` gate via {@link
   * resolveSigningDefaults}. **Keyless is the default** — `keyless: false`
   * plus `key` is the opt-in override for a team with an existing KMS/file
   * key policy (see `./components/verbs/sign.ts`'s module doc for why keyless
   * is never something a beginner has to turn on). `oidcIssuer`/`identity`
   * are the one identity-setup step #622 asks projects to document: the
   * expected signer for `verify`'s identity policy (e.g. GitHub Actions'
   * OIDC issuer + a workflow ref).
   */
  signing?: {
    /** Set false only alongside `key` to opt into key-based signing instead of the keyless default. Omit (or leave `true`) for the default keyless flow. */
    keyless?: boolean;
    /** Expected OIDC issuer for keyless signing/verification (e.g. `"https://token.actions.githubusercontent.com"` for GitHub Actions). Required for `verify`'s identity policy; optional for `sign`/`attest-provenance`, which can rely on cosign's own ambient OIDC detection in CI. */
    oidcIssuer?: string;
    /** Expected signer identity (e.g. a workflow ref URI) `verify` checks the certificate against. Required for `verify`'s identity policy. */
    identity?: string;
    /** Treat `identity` as a regexp rather than a literal match — see `IdentityPolicy.identityIsRegexp` in `./components/verbs/verify.ts`. */
    identityIsRegexp?: boolean;
    /** Opt-in key-based override (a path, or `kms://`/`awskms://`/... reference) for `sign`/`attest-provenance`/`verify` alike. Presence alone does not disable keyless — pair with `keyless: false` for clarity, though a capability call that explicitly sets its own `key`/`policy.key` always wins over this project default either way. */
    key?: string;
  };

  /**
   * Project-wide vulnerability/license policy-gate defaults (#626, epic #551
   * supply-chain follow-up to the SBOM stack). Consumed by
   * `./components/verbs/vuln-gate.ts`'s `vuln-gate` capability via {@link
   * resolveVulnPolicy}. **Beginner-safe defaults** (see `DEFAULT_VULN_POLICY`
   * in `./components/verbs/vuln-gate.ts`): block only `critical` + `fixable` +
   * not-VEX-suppressed findings, warn on `high`, license report-only. Every
   * field here overrides one of those defaults.
   */
  vulnPolicy?: {
    /** Minimum severity that FAILS the gate. Default `"critical"`. */
    failSeverity?: Severity;
    /** Only fixable findings at/above `failSeverity` block. Default `true`. */
    fixableOnly?: boolean;
    /** Minimum severity reported as a warning. Default `"high"`. */
    warnSeverity?: Severity;
    /** Block on a license violation (else report-only). Default `false`. */
    failOnLicense?: boolean;
    /** Block on an `unknown`-severity finding (always warned regardless). Default `false`. */
    failOnUnknownSeverity?: boolean;
    /** Block any finding in the CISA KEV catalog, regardless of severity. Default `false`. */
    failOnKev?: boolean;
    /** Block when EPSS is at or above this (0.0–1.0). Omit to ignore EPSS. */
    failEpssAtOrAbove?: number;
    /** Warn (not block) at or above this EPSS. Omit to ignore. */
    warnEpssAtOrAbove?: number;
    /** Apply `fixableOnly` to exploitability blocks too. Default `true`. */
    exploitabilityFixableOnly?: boolean;
    /** License allow/deny lists evaluated against the SBOM's declared licenses. */
    license?: { allow?: string[]; deny?: string[] };
    /** Which real scanner a `ProcessRunner`-backed `vuln-gate`/`scan-vulnerabilities` shells out to. Default `"grype"`. Read where the capability/scanner is constructed. */
    scanner?: "grype" | "trivy";
    /** Default VEX document paths (OpenVEX/CycloneDX) applied to every gate. Read where the gate step is composed. */
    vexSources?: string[];
  };
}

/**
 * Resolved project configuration with metadata about how it was loaded.
 */
export interface ResolvedConfig {
  /** The loaded configuration */
  config: ChantConfig;

  /** Path to the config file that was loaded, or undefined if defaults */
  configPath?: string;
}

/**
 * Default configuration when no config file exists.
 */
export const DEFAULT_CHANT_CONFIG: ChantConfig = {};

/**
 * Load project configuration from a directory.
 *
 * Tries `chant.config.ts` first, then `chant.config.json`. Returns default
 * config if neither exists.
 *
 * chant #1113 — `chant.config.ts` is project-authored code, so *where* it is
 * evaluated is a security question, and the answer is
 * `./config-sandbox.ts`'s: in a sandboxed child when this process was armed by
 * `chant build --sandbox`, in-process (exactly as before) otherwise. Either
 * way the result is the same plain configuration object, and validation
 * ({@link normalizeConfig}) happens here, in the trusted process.
 * `chant.config.json` is data, not code — it is parsed in-process under
 * `--sandbox` too, because there is nothing to execute.
 */
export async function loadChantConfig(dir: string): Promise<ResolvedConfig> {
  // Try chant.config.ts first
  const tsPath = join(dir, "chant.config.ts");
  if (existsSync(tsPath)) {
    const config = await evaluateProjectConfig(tsPath, dir);
    return { config: normalizeConfig(config as Record<string, unknown>, tsPath), configPath: tsPath };
  }

  // Fall back to chant.config.json
  const jsonPath = join(dir, "chant.config.json");
  if (existsSync(jsonPath)) {
    const { readFileSync } = await import("fs");
    const content = readFileSync(jsonPath, "utf-8");
    const parsed = JSON.parse(content);
    return { config: normalizeConfig(parsed, jsonPath), configPath: jsonPath };
  }

  return { config: DEFAULT_CHANT_CONFIG };
}

/**
 * Load project configuration by walking up from `startDir` to the project
 * root (chant #1117), instead of trying only `startDir` itself.
 *
 * `chant build src/<stack>` (and anything else invoked with a subdirectory —
 * `lint.policies`' `evaluateProjectPolicies`, `--components --generate`)
 * builds scoped to that subdirectory, but `chant.config.ts` almost always
 * lives at the project root, one or more levels up. Before this, callers
 * either read `startDir` alone or bolted on a single `dirname()` fallback —
 * fine for a one-level-deep stack, silently blind to anything deeper
 * (loomster's `src/<stack>` layout is exactly one level too deep: `buildParams`'
 * declared `env:` mappings never resolved, so `LOOM_TIER`/`LOOM_ENV` were inert
 * under every `npm run synth:*` for two releases — loomster#162). Uses the
 * same walk `chant lint`/`chant graph` already used ({@link findProjectConfig},
 * shared with `./lint/config.ts`'s `findProjectRoot`) — one config-discovery
 * contract for the whole CLI.
 *
 * chant #1502 — a lint-scoping fragment does not end the walk. The convention
 * of a `src/chant.config.json` holding only `extends`/`rules` (cc-aws-canonical
 * and most of examples/) sits BETWEEN the build directory and the real
 * `chant.config.ts`, and stopping there re-introduced the exact silent
 * fallback this walk exists to prevent: `chant build src` resolved the
 * fragment, found no `ownership`, and built unstamped manifests that every
 * owned-scoped live read then withheld. A fragment is skipped, not merged —
 * lint resolution keeps its own nearest-wins walk untouched, and a JSON
 * config declaring any project-level key still wins where it stands.
 */
export async function loadChantConfigUpward(startDir: string): Promise<ResolvedConfig> {
  let { dir, configPath } = findProjectConfig(startDir);
  while (configPath && isLintOnlyFragment(configPath)) {
    const parent = dirname(dir);
    if (parent === dir) break;
    ({ dir, configPath } = findProjectConfig(parent));
  }
  if (configPath) warnIfFragmentShadowsProjectConfig(configPath);
  return loadChantConfig(dir);
}

/**
 * The top-level keys of `./lint/config.ts`'s `LintConfigSchema` (plus the
 * `$schema` editor convention). A `chant.config.json` whose keys all come from
 * this set is a lint-scoping fragment, not a project config — see
 * {@link loadChantConfigUpward}. `chant.config.ts` is never a fragment: it is
 * project-authored code, and inspecting it would mean evaluating it.
 */
const LINT_FRAGMENT_KEYS = new Set(["$schema", "extends", "rules", "overrides", "plugins", "policies"]);

/**
 * JSON has no comments, so a project that wants to explain why it disabled a
 * rule reaches for an underscore-prefixed key. chant #1711: both CockroachDB
 * examples carried a `_ruleNotes` object in every stack's fragment, and one
 * unrecognized key was enough to stop the walk — `chant build src/east`
 * resolved the fragment as the project config, found no `buildParams`, no
 * `ownership` and no `lexicons`, and emitted
 * `gke-crdb-east-crdb@undefined.iam.gserviceaccount.com`. Silently.
 *
 * An underscore key is a comment. It does not make a fragment a project config.
 */
const isCommentKey = (k: string): boolean => k.startsWith("_");

function isLintOnlyFragment(configPath: string): boolean {
  if (!configPath.endsWith("chant.config.json")) return false;
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    const keys = Object.keys(parsed).filter((k) => !isCommentKey(k));
    return keys.length > 0 && keys.every((k) => LINT_FRAGMENT_KEYS.has(k));
  } catch {
    // Unreadable/unparseable JSON: let loadChantConfig surface the real error
    // in place rather than silently walking past it.
    return false;
  }
}

/**
 * The `chant.config.json` the walk stopped at declares no project-level key at
 * all — so it is about to be used as the project config while carrying none of
 * the things a project config exists to carry.
 *
 * The comment-key rule above fixes the case that bit (chant #1711), but the
 * hole it came from is general: any key outside {@link LINT_FRAGMENT_KEYS}
 * turns a fragment into the project config, and the consequence is a build
 * that silently loses every parameter, the ownership marker and the lexicon
 * list. This says so, naming the key responsible, instead of leaving it to be
 * discovered in the output.
 */
function warnIfFragmentShadowsProjectConfig(configPath: string): void {
  if (!configPath.endsWith("chant.config.json")) return;
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
    const keys = Object.keys(parsed).filter((k) => !isCommentKey(k));
    if (keys.some((k) => !LINT_FRAGMENT_KEYS.has(k)) && !keys.some((k) => PROJECT_CONFIG_KEYS.has(k))) {
      const offenders = keys.filter((k) => !LINT_FRAGMENT_KEYS.has(k));
      console.error(
        `warning: ${configPath} is being used as the project config, but declares no project-level ` +
          `key (${[...PROJECT_CONFIG_KEYS].slice(0, 4).join(", ")}, …). ` +
          `${offenders.length === 1 ? "The key" : "The keys"} ${offenders.map((k) => `"${k}"`).join(", ")} ` +
          `stopped the walk to the real one — any config above this file is being ignored. ` +
          `Prefix a comment key with "_", or move the key to the project config. (chant #1711)`,
      );
    }
  } catch {
    // Unreadable/unparseable: loadChantConfig reports it properly.
  }
}

/** Top-level keys that make a config a *project* config rather than a lint fragment. */
const PROJECT_CONFIG_KEYS = new Set(Object.keys(ChantConfigSchema.shape).filter((k) => k !== "lint"));

/** Whether an `ownership.env` entry is a build-parameter reference rather than a literal. */
export function isOwnershipParamRef(env: OwnershipEnv | undefined): env is { param: string } {
  return typeof env === "object" && env !== null && typeof env.param === "string";
}

/**
 * The ownership stack identity alone — `ownership.stack` when marking is on
 * (no `stack`, or `enabled: false`, means off). For callers that need the
 * stack and nothing else (a field manager, a prune selector) and so have no
 * build parameters to resolve `env` against.
 */
export function resolveOwnershipStack(config: ChantConfig): string | undefined {
  const o = config.ownership;
  if (!o || !o.stack || o.enabled === false) return undefined;
  return o.stack;
}

/**
 * Resolve the `env` half of the ownership marker (#1396). A literal is
 * returned as-is. A `{ param }` reference is looked up in this build's resolved
 * build parameters and must find one: a reference to a parameter that was
 * never declared, or that resolved to no value, throws rather than quietly
 * stamping a marker without an env — an env-less marker is exactly what lets
 * a prod deployment go unseen by `--owned` filtering scoped to prod.
 */
export function resolveOwnershipEnv(
  config: ChantConfig,
  buildParams: readonly BuildParamProvenance[] | undefined,
): string | undefined {
  const env = config.ownership?.env;
  if (!isOwnershipParamRef(env)) return env;
  const name = env.param;
  const declared = config.buildParams?.[name];
  if (!declared) {
    throw new Error(
      `ownership.env references build parameter "${name}", which chant.config.ts's buildParams does not declare`,
    );
  }
  const resolved = buildParams?.find((p) => p.name === name);
  if (!resolved) {
    throw new Error(
      `ownership.env references build parameter "${name}", which resolved to no value for this build — pass --param ${name}=<value>${declared.env ? `, set ${declared.env}` : ""}, or give it a default`,
    );
  }
  return String(resolved.value);
}

/**
 * Resolve the ownership marker to stamp from project config, or undefined when
 * ownership marking is off (no `stack`, or `enabled: false`). `buildParams` is
 * this build's resolved parameters (`resolveBuildParams`'s provenance), which
 * an `ownership.env: { param }` reference resolves against — see {@link
 * resolveOwnershipEnv}; it throws when the reference cannot be satisfied.
 */
export function resolveOwnershipMarker(
  config: ChantConfig,
  buildParams?: readonly BuildParamProvenance[],
): OwnershipMarker | undefined {
  const stack = resolveOwnershipStack(config);
  if (stack === undefined) return undefined;
  return { stack, env: resolveOwnershipEnv(config, buildParams) };
}

/**
 * The divergence #1396 is about, made loud when it cannot be removed: a
 * project whose `ownership.env` is a literal while it also declares a build
 * parameter named `env` has two answers to "which environment is this", and
 * the manifest carries both (the ownership marker from config, the labels
 * from the parameter). Returns a warning naming both values when they differ;
 * undefined when there is nothing to say (no literal, no `env` parameter, or
 * the two agree). The fix is the `{ param: "env" }` reference.
 */
export function ownershipEnvDisagreement(
  config: ChantConfig,
  buildParams: readonly BuildParamProvenance[] | undefined,
): string | undefined {
  const literal = config.ownership?.env;
  if (typeof literal !== "string") return undefined;
  if (resolveOwnershipStack(config) === undefined) return undefined;
  const param = buildParams?.find((p) => p.name === "env");
  if (!param || String(param.value) === literal) return undefined;
  return (
    `ownership.env is "${literal}" but the env build parameter resolved to ${JSON.stringify(param.value)} (${param.source}) — ` +
    `the ownership marker and params.env disagree about which environment this build is for. ` +
    `Use ownership: { env: { param: "env" } } so the marker follows the parameter.`
  );
}

/**
 * Whether auto-emitting a release-ledger record after a successful `chant
 * run --components` deploy should be skipped (#597). Opt-out, not opt-in:
 * recording happens unless the CLI's `--no-release-record` flag was passed
 * (`cliFlag`) or the project config sets `release.autoRecord: false` — the
 * flag always wins for that one invocation, regardless of config.
 */
export function resolveAutoReleaseDisabled(config: ChantConfig, cliFlag?: boolean): boolean {
  if (cliFlag) return true;
  return config.release?.autoRecord === false;
}

/**
 * Whether `chant build` should use the fold path (#1022, epic #1019)
 * instead of running each source module. DEFAULT-ON since chant #1134: fold
 * is the build path unless something turns it off. Precedence, most specific
 * wins: an explicit CLI flag (`--fold` → true, `--no-fold` → false, arriving
 * here as `cliFlag`), then the project config's `build.fold`, then the
 * default of `true`. The epic's evidence base for the flip — coverage,
 * byte-identity, and the sandbox execution boundary — is recorded on #1134
 * and #1090.
 */
export function resolveFoldEnabled(config: ChantConfig, cliFlag?: boolean): boolean {
  if (cliFlag !== undefined) return cliFlag;
  if (config.build?.fold !== undefined) return config.build.fold;
  return true;
}

/**
 * Whether `chant build` should run its run-fallback files (or, without
 * `--fold`, every file) in an isolated sandboxed child process rather than
 * in-process (chant #1045 Phase 2). Opt-in: off unless the CLI's `--sandbox`
 * flag was passed (`cliFlag`) or the project config sets `build.sandbox:
 * true` — the flag always wins for that one invocation, regardless of
 * config. Independent of {@link resolveFoldEnabled}: sandboxing without
 * folding isolates every discovered file; sandboxing with folding isolates
 * only the per-file run-fallback remainder.
 */
export function resolveSandboxEnabled(config: ChantConfig, cliFlag?: boolean): boolean {
  if (cliFlag) return true;
  return config.build?.sandbox === true;
}

/**
 * Resolve which SBOM format a `generate-sbom` step should request (#606),
 * given the project's `chant.config.ts` `sbom.format` and an optional
 * component/step-level override. Precedence, most to least specific:
 * `stepFormat` (the component's own `build.sbom.format` or an explicit
 * `generate-sbom` step input) > `config.sbom.format` (project default) >
 * `DEFAULT_SBOM_FORMAT` ("spdx", ./components/verbs/sbom-generator.ts).
 * Never hardcodes one format as *the* format — this is purely precedence
 * resolution over the two first-class formats SPDX/CycloneDX.
 */
export function resolveSbomFormat(config: ChantConfig, stepFormat?: SbomFormat): SbomFormat {
  return stepFormat ?? config.sbom?.format ?? DEFAULT_SBOM_FORMAT;
}

/**
 * Resolved signing defaults a `sign`/`attest-provenance`/`verify` capability
 * call can spread its own `keyless`/`key`/`policy` input over (#622). Shaped
 * to match `./components/verbs/sign.ts`'s `KeyBasedSigningConfig` (the `key`
 * field) and `./components/verbs/verify.ts`'s `IdentityPolicy` (`expectedIssuer`/
 * `expectedIdentity`/`identityIsRegexp`) so a caller can do
 * `{ ...resolveSigningDefaults(config).identityPolicyDefaults, ...override }`
 * without a config module import inside `./components/verbs/*` (no verb
 * module imports `../../config.ts` directly — same convention `resolveSbomFormat`'s
 * callers already follow: the orchestrator/caller resolves config, capabilities
 * stay config-free).
 */
export interface ResolvedSigningDefaults {
  /** False only when the project opted into the key-based override (`signing.keyless === false`). True (keyless) otherwise — the #622 default. */
  keyless: boolean;
  /** `./components/verbs/sign.ts`'s `KeyBasedSigningConfig`, present only when key-based signing is configured (`signing.key` set). */
  key?: { key: string };
  /** Partial `./components/verbs/verify.ts` `IdentityPolicy` fields resolved from project config — a caller still supplies any per-call override and must ensure `expectedIssuer`/`expectedIdentity` end up set before calling `verify` (config alone does not guarantee both are present). */
  identityPolicyDefaults: {
    expectedIssuer?: string;
    expectedIdentity?: string;
    identityIsRegexp?: boolean;
    key?: string;
  };
}

/**
 * Resolve project-wide signing defaults from `chant.config.ts`'s `signing`
 * section (#622). Keyless unless `signing.keyless === false` — the same
 * "default is the safe choice, override is explicit" precedence
 * `resolveOwnershipMarker`/`resolveAutoReleaseDisabled` already use for their
 * respective opt-outs.
 */
export function resolveSigningDefaults(config: ChantConfig): ResolvedSigningDefaults {
  const s = config.signing;
  const keyless = s?.keyless !== false;
  return {
    keyless,
    ...(!keyless && s?.key ? { key: { key: s.key } } : {}),
    identityPolicyDefaults: {
      expectedIssuer: s?.oidcIssuer,
      expectedIdentity: s?.identity,
      identityIsRegexp: s?.identityIsRegexp,
      key: s?.keyless === false ? s?.key : undefined,
    },
  };
}

/**
 * Resolve the `vuln-gate` policy overrides from `chant.config.ts`'s
 * `vulnPolicy` section (#626). Returns only the fields the project set; the
 * gate merges these over its own `DEFAULT_VULN_POLICY`
 * (`./components/verbs/vuln-gate.ts`), so an empty/absent section yields the
 * beginner-safe defaults. `scanner`/`vexSources` are not policy fields — they
 * configure how the capability is constructed and are read separately.
 */
export function resolveVulnPolicy(config: ChantConfig): Partial<VulnPolicy> {
  const v = config.vulnPolicy;
  if (!v) return {};
  const out: Partial<VulnPolicy> = {};
  if (v.failSeverity) out.failSeverity = v.failSeverity;
  if (v.fixableOnly !== undefined) out.fixableOnly = v.fixableOnly;
  if (v.warnSeverity) out.warnSeverity = v.warnSeverity;
  if (v.failOnLicense !== undefined) out.failOnLicense = v.failOnLicense;
  if (v.failOnUnknownSeverity !== undefined) out.failOnUnknownSeverity = v.failOnUnknownSeverity;
  // `!== undefined`, never truthiness: `failEpssAtOrAbove: 0` (match any scored
  // finding) and an explicit `failOnKev: false` override must both survive.
  if (v.failOnKev !== undefined) out.failOnKev = v.failOnKev;
  if (v.failEpssAtOrAbove !== undefined) out.failEpssAtOrAbove = v.failEpssAtOrAbove;
  if (v.warnEpssAtOrAbove !== undefined) out.warnEpssAtOrAbove = v.warnEpssAtOrAbove;
  if (v.exploitabilityFixableOnly !== undefined) out.exploitabilityFixableOnly = v.exploitabilityFixableOnly;
  if (v.license) out.license = v.license;
  return out;
}

/**
 * Validate and normalize a raw config object into ChantConfig shape.
 */
function normalizeConfig(raw: Record<string, unknown>, source?: string): ChantConfig {
  if (typeof raw !== "object" || raw === null) {
    return DEFAULT_CHANT_CONFIG;
  }

  const result = ChantConfigSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue.path.length > 0 ? issue.path.join(".") : undefined;
    const loc = source ? ` in ${source}` : "";
    throw new Error(`Invalid chant config${loc}: ${path ? `${path}: ` : ""}${issue.message}`);
  }

  return raw as ChantConfig;
}
