import { existsSync } from "fs";
import { join } from "path";
import { z } from "zod";
import type { LintConfig } from "./lint/config";
import type { OwnershipMarker } from "./ownership";
import { DEFAULT_SBOM_FORMAT, type SbomFormat } from "./components/verbs/sbom-generator";
import type { Severity } from "./components/verbs/vuln-scan";
import type { VulnPolicy } from "./components/verbs/vuln-gate";

/**
 * Zod schema for ChantConfig validation.
 */
export const ChantConfigSchema = z.object({
  lexicons: z.array(z.string().min(1)).optional(),
  capabilities: z.array(z.string().min(1)).optional(),
  environments: z.array(z.string().min(1)).optional(),
  sourceDir: z.string().min(1).optional(),
  lint: z.record(z.string(), z.unknown()).optional(),
  ownership: z.object({
    stack: z.string().min(1).optional(),
    env: z.string().min(1).optional(),
    enabled: z.boolean().optional(),
  }).optional(),
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

  /** Environment names (e.g. ["staging", "prod"]) */
  environments?: string[];

  /**
   * Directory (relative to the project root) that holds the chant infrastructure
   * source. Lifecycle commands (`snapshot`/`diff`/`plan`) build from here instead
   * of the project root, so a mixed-layout project — chant `src/` alongside app
   * code that has import side effects — can scope the build to just the infra.
   * Defaults to "." (the project root). The `--src` flag overrides it.
   */
  sourceDir?: string;

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
    /** Optional environment identity. */
    env?: string;
    /** Set false to disable stamping even when `stack` is present. */
    enabled?: boolean;
  };

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
 * Tries `chant.config.ts` first (via dynamic import), then `chant.config.json`.
 * Returns default config if neither exists.
 */
export async function loadChantConfig(dir: string): Promise<ResolvedConfig> {
  // Try chant.config.ts first
  const tsPath = join(dir, "chant.config.ts");
  if (existsSync(tsPath)) {
    const mod = await import(tsPath);
    const config = mod.default ?? mod.config ?? mod;
    return { config: normalizeConfig(config, tsPath), configPath: tsPath };
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
 * Resolve the ownership marker to stamp from project config, or undefined when
 * ownership marking is off (no `stack`, or `enabled: false`).
 */
export function resolveOwnershipMarker(config: ChantConfig): OwnershipMarker | undefined {
  const o = config.ownership;
  if (!o || !o.stack || o.enabled === false) return undefined;
  return { stack: o.stack, env: o.env };
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
