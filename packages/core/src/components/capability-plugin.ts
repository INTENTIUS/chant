/**
 * Capability plugin contract — Phase 2 (#559, epic #551).
 *
 * Promotes the Phase 1 capability registry convention
 * (`createCapabilityRegistry`/`STARTER_VERB_FAMILIES`, ./registry.ts) to a
 * first-class chant plugin contract, mirroring the lexicon plugin contract
 * (../lexicon.ts, ../cli/plugins.ts) so capabilities become typed,
 * discoverable packages resolved by `kind`, the same way lexicons are
 * discovered and resolved by resource type.
 *
 * Shape parity with `LexiconPlugin` (../lexicon.ts):
 *  - `name`/`version` mirror `LexiconManifest.name`/`.version`.
 *  - `capabilities()` is the required lifecycle method (like a lexicon's
 *    `serializer`/`generate`/`validate`) every capability package must
 *    implement — it returns the typed `Capability` instances this package
 *    contributes, registered by `kind` the same way a lexicon's resource
 *    types are registered by `resourceType`.
 *  - `families()`, `init()` are optional extensions, mirroring
 *    `LexiconPlugin`'s optional `lintRules`/`init`/etc.
 *  - `isCapabilityPlugin` is the runtime type guard `loadCapabilityPlugin`
 *    (./capability-plugin-loader.ts) uses to validate a dynamically-imported
 *    package before trusting it — the same defensive shape check
 *    `isLexiconPlugin` performs for lexicons.
 *
 * The starter verb set (./registry.ts) becomes the built-in, always-loaded
 * plugin (`starterCapabilityPlugin`, ./starter-plugin.ts) under this same
 * contract — see that module's docstring for the Phase 1 -> Phase 2
 * migration path and the "no behavior change" guarantee.
 */

import type { Capability } from "./capability";

/**
 * Manifest for a packaged capability plugin — the capability-side analogue
 * of `LexiconManifest` (../lexicon.ts). Kept as a plain data shape (rather
 * than folded into `CapabilityPlugin`) so it can be serialized alongside a
 * package (e.g. into a future tarball/`meta.json`, matching how lexicons
 * carry `LexiconManifest` in their `BundleSpec`) independent of the runtime
 * plugin object.
 */
export interface CapabilityManifest {
  /** Package/plugin name (e.g. "aws", "gcp"), not a capability `kind`. */
  name: string;
  /** Plugin package version (semver). */
  version: string;
  /** Minimum/compatible chant core version, checked the same way as `LexiconManifest.chantVersion` (see ../lexicon-manifest.ts's `checkVersionCompatibility`). */
  chantVersion?: string;
  /** Every capability `kind` this plugin contributes — informational/validation aid; must match what `capabilities()` actually returns. */
  kinds?: string[];
}

/**
 * Plugin interface for capability packages — the capability-side analogue of
 * `LexiconPlugin` (../lexicon.ts). A capability plugin ships one or more
 * typed `Capability` implementations, discovered and loaded the same way a
 * lexicon plugin is: dynamically imported by a package-naming convention
 * (`@intentius/chant-capability-<name>`, see ./capability-plugin-loader.ts),
 * validated with a runtime shape guard, then registered into a
 * `CapabilityRegistry` the driver resolves verbs through by `kind`.
 *
 * Required lifecycle method enforces consistency: every capability package
 * must be able to enumerate the capabilities it contributes.
 */
export interface CapabilityPlugin {
  // ── Required ──────────────────────────────────────────────
  /** Human-readable plugin/package name (e.g. "aws", "gcp"), not a capability `kind`. */
  readonly name: string;

  /** Plugin package version (semver), mirrors `LexiconManifest.version`. */
  readonly version: string;

  /** Return every `Capability` this plugin contributes, keyed for registration by its own `kind`. */
  capabilities(): Array<Capability<never, unknown>>;

  // ── Optional extensions ───────────────────────────────────
  /** Minimum/compatible chant core version this plugin requires (checked via ../lexicon-manifest.ts's `checkVersionCompatibility`). */
  readonly chantVersion?: string;

  /** Capability kinds grouped by family, informational — mirrors `STARTER_VERB_FAMILIES` (./registry.ts) shape for third-party plugins that want to publish the same grouping. */
  families?(): Record<string, readonly string[]>;

  /** Optional initialization hook, called once after load (mirrors `LexiconPlugin.init`). */
  init?(): void | Promise<void>;
}

/**
 * Type guard to check if a value is a `CapabilityPlugin`. Checks for the
 * required `name`/`version`/`capabilities` shape, the same defensive check
 * `isLexiconPlugin` (../lexicon.ts) performs before a dynamically-imported
 * package is trusted and registered. This is also chant's detector for a
 * *malformed* capability package (#559 acceptance criteria): a package
 * missing any of these fails the guard and is rejected by the loader with a
 * descriptive error rather than registered half-working.
 */
export function isCapabilityPlugin(value: unknown): value is CapabilityPlugin {
  if (
    typeof value !== "object" ||
    value === null ||
    !("name" in value) ||
    typeof (value as Record<string, unknown>).name !== "string" ||
    !("version" in value) ||
    typeof (value as Record<string, unknown>).version !== "string"
  ) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return typeof obj.capabilities === "function";
}
