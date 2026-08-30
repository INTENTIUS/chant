/**
 * The carve provider seam (#2016).
 *
 * `carve advise|emit|bridge` used to reach into the AWS carve table directly:
 * the tier map derived from it, the emit gate was `awsCarveType(t) !== undefined`,
 * the adopter called `applyAwsMapper`, and the emitted project's lexicon was a
 * constant. A second provider — Kubernetes emit (#999), GCP (#2017) — had
 * nowhere to land except a parallel path beside the AWS one.
 *
 * A provider owns one or more Terraform type prefixes and answers everything
 * the carve commands ask about the types under them: how each ranks against a
 * native spec, which HCL attribute carries the physical name, which
 * sub-resources fold into a parent, which types emit can produce source for,
 * and how to adopt one from `.tfstate`.
 *
 * ── Why the registry lives in core, not behind a `LexiconPlugin` capability ──
 *
 * `carve advise` runs against a Terraform directory that is not a chant project:
 * there is no `chant.config.ts` naming lexicons, so there is nothing to load
 * plugins from, and `carve emit --state` is deliberately offline (see the
 * handler). Behind a plugin capability both would have to load plugins to learn
 * that a type ranks tier 1. Providers are also Terraform-provider knowledge
 * (`terraform-provider-aws` attribute names), which belongs beside the HCL
 * parser rather than inside a lexicon.
 *
 * `registerCarveProvider` is exported, so a plugin that wants to contribute a
 * provider at runtime still can — the seam does not foreclose it, it just does
 * not require plugin loading for the paths that run without one.
 */

import { BUILTIN_CARVE_PROVIDERS } from "./providers";
import type { StateResource } from "./state";

export interface TierInfo {
  tier: 1 | 2 | 3;
  /** The native spec type a carve would target, for the report. */
  mapsTo: string;
}

/**
 * One deferred outbound input turned into a build parameter (#998). Derived
 * from the boundary report's outbound edges + the state's resolved attributes
 * in `carve-emit.ts`; consumed by a provider's `adopt` (source substitution)
 * and by the scaffold (`chant.config.ts` `buildParams` declaration).
 */
export interface DeferredParam {
  /** Build-parameter name, source-referenceable (`params.<name>`). */
  name: string;
  /** The carved resource's own Terraform attribute the value enters through. */
  tfAttr: string;
  /** The survivor the Terraform source read, e.g. `aws_vpc.main`. */
  survivor: string;
  /** Survivor attribute(s) read, e.g. `["id"]`. */
  attrs: string[];
  /** The state-resolved value — the parameter's declared default. */
  default?: string | number | boolean;
}

/** What one folded sub-resource contributed to the parent's emitted props (#1637). */
export interface FoldedContribution {
  /** The sub-resource's Terraform address, e.g. `aws_s3_bucket_versioning.assets`. */
  address: string;
  /** Native properties it added to the parent, e.g. `["VersioningConfiguration"]`. */
  props: string[];
}

export interface AdoptedSource {
  fileName: string;
  content: string;
  /** True when at least one attribute was mapped to a native prop. */
  mapped: boolean;
  nativeType: string;
  /** Deferred params actually substituted into the emitted props (#998). */
  parameterized: string[];
  /** Folded sub-resources and the props each one joined into the parent (#1637). */
  folded: FoldedContribution[];
}

export interface CarveProvider {
  /** Registry id, unique. Registering a second provider under it replaces the first. */
  readonly name: string;
  /**
   * Terraform type prefixes this provider owns, e.g. `["aws_"]`. Resolution
   * takes the longest match, so a narrower provider can claim a subset of a
   * wider one's prefix.
   */
  readonly tfTypePrefixes: readonly string[];
  /**
   * The chant lexicon emitted source targets — the scaffolded project's
   * dependency and `--lexicon` flag, and the lexicon the live import runs
   * against.
   */
  readonly lexicon: string;
  /** Terraform type → native tier, contributed to the advisor's tier map. */
  readonly tiers: Readonly<Record<string, TierInfo>>;
  /**
   * Terraform type → the HCL attribute carrying the physical name. A dotted
   * entry is a path into nested blocks (`manifest.metadata.name`); the bridge
   * refuses those, since a data-source body is flat `attr = value`.
   */
  readonly identityAttrs?: Readonly<Record<string, string>>;
  /**
   * Sub-resource Terraform type → parent type, for types Terraform splits out
   * of the resource the native spec keeps them in.
   */
  readonly foldsInto?: Readonly<Record<string, string>>;
  /**
   * Terraform types `carve emit` can produce chant source for — narrower than
   * `tiers`, which advise also ranks types no emit path can adopt. Absent or
   * empty means advise-only. Declaring types here obliges the provider to
   * implement {@link adopt}: both emit paths gate on the same list (#2015), so
   * a type the live path accepts must be adoptable from state too.
   */
  readonly emitTypes?: readonly string[];
  /** Adopt a resource from Terraform state into chant source. */
  adopt?(resource: StateResource, params: DeferredParam[], folded: StateResource[]): AdoptedSource | null;
  /**
   * The native selector type the live (cloud→code) import filters on, e.g.
   * `AWS::S3::Bucket`. Undefined when this type has no live adoption path —
   * `carve emit --env` refuses it rather than importing the wrong thing.
   */
  liveSelectorType?(tfType: string): string | undefined;
}

/**
 * A provider declaring emit types without an adopter would accept a type on
 * `--env` and fail it on `--state`, the advise↔emit cliff #2015 closed.
 */
function validate(provider: CarveProvider): void {
  if (provider.emitTypes?.length && !provider.adopt) {
    throw new Error(`Carve provider "${provider.name}" declares emitTypes but no adopt() — the --state path would refuse what --env accepts.`);
  }
  if (!provider.tfTypePrefixes.length) {
    throw new Error(`Carve provider "${provider.name}" claims no Terraform type prefix, so no type would ever resolve to it.`);
  }
}

const providers: CarveProvider[] = [...BUILTIN_CARVE_PROVIDERS];
for (const p of providers) validate(p);

/** Bumped on every registry mutation, so the derived indexes rebuild. */
let revision = 0;

/**
 * Register a carve provider. Returns a function that removes it again, so a
 * test (or a plugin unloading) leaves the registry as it found it.
 */
export function registerCarveProvider(provider: CarveProvider): () => void {
  validate(provider);
  const existing = providers.findIndex((p) => p.name === provider.name);
  if (existing >= 0) providers.splice(existing, 1);
  providers.push(provider);
  revision++;
  return () => {
    const at = providers.indexOf(provider);
    if (at < 0) return;
    providers.splice(at, 1);
    revision++;
  };
}

/** Every registered provider, in registration order. */
export function carveProviders(): readonly CarveProvider[] {
  return providers;
}

interface RegistryIndex {
  /** Prefixes longest-first, so the narrowest claim wins. */
  prefixes: Array<{ prefix: string; provider: CarveProvider }>;
  tiers: Record<string, TierInfo>;
  identityAttrs: Record<string, string>;
  foldsInto: Record<string, string>;
  /** Terraform type → the provider that emits it. */
  emitters: Map<string, CarveProvider>;
}

let cached: { revision: number; index: RegistryIndex } | null = null;

function index(): RegistryIndex {
  if (cached && cached.revision === revision) return cached.index;
  const built: RegistryIndex = {
    prefixes: [],
    tiers: {},
    identityAttrs: {},
    foldsInto: {},
    emitters: new Map(),
  };
  for (const provider of providers) {
    for (const prefix of provider.tfTypePrefixes) built.prefixes.push({ prefix, provider });
    Object.assign(built.tiers, provider.tiers);
    if (provider.identityAttrs) Object.assign(built.identityAttrs, provider.identityAttrs);
    if (provider.foldsInto) Object.assign(built.foldsInto, provider.foldsInto);
    for (const tfType of provider.emitTypes ?? []) built.emitters.set(tfType, provider);
  }
  built.prefixes.sort((a, b) => b.prefix.length - a.prefix.length);
  cached = { revision, index: built };
  return built;
}

/** The provider owning this Terraform type, by longest prefix match. */
export function resolveCarveProvider(tfType: string): CarveProvider | undefined {
  return index().prefixes.find((p) => tfType.startsWith(p.prefix))?.provider;
}

/**
 * The provider that can emit chant source for this Terraform type. Narrower
 * than {@link resolveCarveProvider}: a provider owns every type under its
 * prefix for advise, and only the ones on its `emitTypes` list for emit.
 */
export function resolveEmitProvider(tfType: string): CarveProvider | undefined {
  return index().emitters.get(tfType);
}

/** Every Terraform type any registered provider can emit, sorted, for user-facing hints. */
export function carveEmitTypes(): string[] {
  return [...index().emitters.keys()].sort();
}

/** The lexicons emit can adopt into, sorted — what the CLI loads plugins for. */
export function carveEmitLexicons(): string[] {
  return [...new Set([...index().emitters.values()].map((p) => p.lexicon))].sort();
}

/** Terraform resource type → native tier, merged over every provider. Read-only: it is the cached index. */
export function carveTierMap(): Readonly<Record<string, TierInfo>> {
  return index().tiers;
}

/** The HCL attribute carrying this type's physical name, if its provider declares one. */
export function carveIdentityAttr(tfType: string): string | undefined {
  return index().identityAttrs[tfType];
}

/** The parent Terraform type this sub-resource folds into, if any. */
export function carveFoldParent(tfType: string): string | undefined {
  return index().foldsInto[tfType];
}
