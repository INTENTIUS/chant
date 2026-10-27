/**
 * Live observation for declared terraform entities (#2087, #2104).
 *
 * `buildRoots()` turns each configured root module into one entity per HCL
 * block, keyed `<root>/<address>` (`./hcl/parse.ts`). This reader answers the
 * lifecycle question for those entities, and how it answers depends on one
 * fact the parse already recorded on every entity: the root's `mode`.
 *
 * A **stock** root is read with `terraform show -json` over its state, and
 * state membership is the ownership answer. A **live** root, meaning
 * `terraform.binary` is `"choudoufu"` and the root declares an estate
 * (#2103), has no state to show: it is read with `choudoufu live-plan -json`,
 * and the marker on the resource is the ownership answer. The two halves are
 * two adapters over the same `observeEntities` harness, picked per root.
 *
 * ## Which of the two answered is on the wire (#2267)
 *
 * They are different claims. `terraform show -json` says what the last apply
 * recorded; `choudoufu live-plan -json` says what the account holds now. A
 * renderer that paints an observation as drift and cannot tell them apart
 * paints a state read green, which reads as "the account matches" when all it
 * says is "the apply finished". For an estate that has decided state is never
 * the system of record, a state-backed observation is not a weaker answer, it
 * is a different one.
 *
 * So the returned `ObservationResult` carries `sources`, keyed by chant entity
 * name, with one of exactly four values:
 *
 * - `"state"`: this entity's root was read with `terraform show -json`.
 * - `"live"`: this entity's root was read with `choudoufu live-plan -json`.
 * - `"plan"`: this entity's root was read at the plan depth (#4358), a saved
 *   plan's `show -json`, which says what the next apply would do. See the
 *   plan depth section below.
 * - `"live+plan"`: a live root at the plan depth (#4371), where both reads
 *   answered: `live-plan -json` for presence and ownership, the plan read for
 *   the attributes. A live root whose plan read failed says `"live"`.
 *
 * Three guarantees a consumer may rely on. Every entity `describeResources`
 * was asked about that belongs to a root has an entry, whatever verdict it
 * came back with: present, absent and not-observed alike, because which read
 * was attempted is a fact independent of what it found. On a root read at the
 * default depth the value equals the declared entity's own `props.mode`
 * (`./hcl/parse.ts`), since one fact decides both, so `props.mode` is also a
 * valid join key for a consumer holding the declared graph and no
 * observation; the plan depth is chosen at read time, so only `sources` says
 * it was used. And a project mixing stock
 * and live roots gets both values in one document, which is why this is a map
 * and not a field on the result as a whole.
 *
 * An entity with no root gets no entry, for the same reason it gets no read.
 *
 * ## The state file is the ownership answer, on a stock root
 *
 * Every other lexicon in chant stamps a tag or a label at synthesis and reads
 * it back off the live resource. Terraform stamps nothing, and there is
 * nowhere to stamp: a resource's provider-side tags are the practitioner's
 * own, and writing chant's marker into them would edit an estate this lexicon
 * promises never to write. What terraform has instead is the thing chant
 * elsewhere refuses to host, a trusted state file that already records
 * exactly which addresses this configuration manages.
 *
 * So the answer here is state membership. An address `terraform show -json`
 * returns is `owned`; anything else is `unknown`. Concretely that makes a
 * declared `module` block `unknown`: the state carries the module's
 * resources, never a row for the block itself, so chant can see the block is
 * live without the state ever saying that block is managed. `unknown` never
 * escalates to a delete, which is the correct posture for a thing chant did
 * not read a verdict for.
 *
 * That places a stock terraform root on the trusted-state-file row of the
 * third axis in docs/src/content/docs/concepts/lifecycle-models.mdx, where
 * chant elsewhere sits on the live-marker row. `docs/pages/observation.mdx`
 * is the reader's version of this paragraph.
 *
 * ## The marker is the ownership answer, on a live root
 *
 * choudoufu keeps no authoritative state file. Every taggable resource it
 * manages carries `tofu-estate` and `tofu-address` tags written in the create
 * call, prior state is rebuilt from the live system each run, and the state
 * file, where one exists at all, is a disposable cache. So a live root is on
 * the live-marker row, the row every other chant lexicon sits in.
 *
 * chant does not re-derive that verdict from the tags. `live-plan -json`
 * (choudoufu issue #788) already splits every declared instance four ways,
 * and those four are the classification:
 *
 * | live-plan section | chant |
 * |---|---|
 * | `bound[]`, `source: "marker"` | present, `owned`; the marker named this estate and this address, and it is surfaced as `ResourceMetadata.marker` |
 * | `bound[]`, any other source | present, `owned` by derivation, record, or cache; noted as such, and no marker is surfaced because none was read |
 * | `unowned[]` with `adopt_*` | present, `unknown`; an adoptable match, carrying the exact two tag values #2105 would write |
 * | `unowned[]` without | present, `foreign`; a live resource is in the way at a declared identity and the plan will not touch it |
 * | `adoptable[]` | present, `unknown`; the same adoptable verdict, for a live resource the sweep content-matched to a declaration that carries no identity of its own (choudoufu #962, chant #2241) |
 * | `omissions[]` | not-observed, `ABSENT` excepted (see below) |
 *
 * The ownership channel this declares is `./live-ownership.ts`'s
 * `TERRAFORM_LIVE_MARKER_KEYS`, and its module doc holds the record of why
 * the keys are declared while the verdicts are set here by hand rather than
 * core's `OwnershipChannel` growing a classifier for them.
 *
 * ### `ABSENT` is absence, and the rest of the omissions are not
 *
 * An omission is choudoufu saying an instance is missing from prior state,
 * with a reason. Most of those reasons are claims of ignorance and become
 * NOT-OBSERVED, which is what the tri-state exists for. One is not:
 * `ABSENT` means "the instance has a usable import identity and the provider
 * reported, normally, that no such object exists", which is exactly chant's
 * OBSERVED-ABSENT, spelled "in neither map". Reporting it as not-observed
 * instead would mean a live root could never propose a create for a resource
 * that genuinely is not there yet, which is the opposite of the honesty the
 * contract is for. `UNOWNED` is the other exception, in the other direction:
 * the `unowned[]` section answers for that address with a real verdict, so
 * the paired omission is never read on its own.
 *
 * ### A block's instances, aggregated
 *
 * chant's entity is the HCL block, `aws_eip.pool`; the document's rows are
 * instances, `aws_eip.pool[0]`. So a block's verdict is the aggregate of its
 * instances, in this precedence: any instance not-observed makes the block
 * not-observed, then foreign, then adoptable, then owned, and a block whose
 * instances are all absent is absent. Partial knowledge is not knowledge,
 * which is the same rule choudoufu applies to its own `INCOMPLETE_BLOCK`.
 * The precedence is core's `TERRAFORM_INSTANCE_ROLLUP` and the rollup is
 * core's `rollupInstances` (`@intentius/chant/instance-nodes`, #4454), the
 * one place it is written.
 *
 * The block's verdict is not the whole answer. A present block also carries
 * each instance's own verdict on `instances`, keyed as Terraform prints it
 * (`[0]`, `["a"]`), which the live graph draws as an instance node under the
 * block node (#4454). The state read does the same with the rows it found.
 *
 * ## What is readable at all
 *
 * `values.root_module.resources[]` (and, recursively, `child_modules[]`)
 * carries `resource` and `data` blocks. A `terraform`, `provider`, `variable`,
 * `output` or `locals` block has no row there and reads `unsupported-kind`.
 * That is honest, not a gap to close by inventing an address for something
 * that has none.
 *
 * A live root reads one block narrower. `live-plan`'s document is prior state
 * for managed resources, so a `data` block has no row in it either and reads
 * `unsupported-kind` there, where the stock reader can answer for it.
 *
 * ## Tri-state (#1089)
 *
 * A root whose `init` or `show` fails, or whose `live-plan` fails, reports
 * EVERY entity declared in that root as not-observed with the mapped reason
 * and the root named, never absent. A failed read must never render as a list
 * of creates. Roots are read independently and merged (`mergeObservations`),
 * so one broken backend does not un-observe a root that answered.
 *
 * ## Beyond the declared estate, on a live root
 *
 * `live-ls -estate -json` lists the whole estate off the Resource Groups
 * Tagging API with no configuration read at all, which is a question a state
 * file cannot answer: what does this estate hold that nothing declares? That
 * is what makes `ambientKinds()`, `observeAmbient()` and `teardownOwned()`
 * implementable on this lexicon for the first time. `-consistent` is always
 * passed, because that index lags a tag write by about a minute
 * (`live-ls`'s own help text) and a listing taken right after an apply can
 * otherwise show a resource under both its old and new estate, or neither.
 *
 * ## The plan depth (#4358)
 *
 * A stock root can be read one depth further: `terraform.observe` (or a
 * root's own `observe`) set to `"plan"`, or `CHANT_TERRAFORM_OBSERVE=plan`,
 * or `depth: "plan"` from a caller. The read is `terraformPlanRead`:
 * `plan -input=false -lock=false -out=<tmp>/plan.tfplan`, then `show -json`,
 * with `<tmp>` under the OS temp directory and removed afterwards, and no
 * `init`. Presence and ownership come from the plan's `prior_state` by the
 * state read's own rule; `./plan-observation.ts` adds the plan's attributes
 * (`planAction`, `planReplacePaths`, `planAfterUnknown`, `planDrift`, ...)
 * to each present block, with sensitive values redacted.
 *
 * It falls back by depth (`planAdapter`): no provider credentials -> the
 * state read; no backend, or a root that needs `init` -> declared only. Each
 * root gets a note saying which read answered. A planned create has no row in
 * `prior_state` and reads absent, as on the state read, so its plan
 * attributes have nowhere to ride.
 *
 * ### On a live root (#4371)
 *
 * `live-plan -json` carries ownership and no attribute values (behold#404),
 * and `choudoufu plan -out` writes a stock plan file (choudoufu #878). So a
 * live root at the plan depth runs both (`livePlanDepthAdapter`):
 * `live-plan -json` first, unchanged, for presence and ownership, then the
 * same `terraformPlanRead` a stock root gets, whose attributes are added to
 * each block `live-plan` bound. A foreign or adoptable block gets none: the
 * plan proposes a create there, which is choudoufu's answer for an instance
 * it does not own, not a fact about the live resource. `sources` reads
 * `"live+plan"`.
 *
 * choudoufu rebuilds prior state from the account on every run, so on a live
 * root out-of-band drift is not in `resource_drift`. It is the planned
 * `update` itself: `planChanges` has the live value as `before` and the
 * declared one as `after`, and `planDrift` stays empty. That is where #2472's
 * property-level drift for a live root comes from.
 *
 * Falling back is one step: if the plan read fails, `live-plan` alone
 * answered, the note says why, and `sources` reads `"live"`. If `live-plan`
 * fails the root is not observed, as at the default depth, and the plan read
 * is not tried, since its attributes would have no present block to ride.
 * The cost is two refreshes of the estate per read, run one after the other
 * so they never share the root's cache file.
 *
 * ## Nothing from `values` is surfaced
 *
 * A state row's `values` are the resource's full attribute set, secrets
 * included, and `sensitive_values` describes only what the configuration
 * declared sensitive. So the attributes reported here are the row's identity
 * (address, type, mode, provider, root) and nothing from `values` except the
 * `id`, which is the physical id every observation carries.
 */

import type {
  DescribeResourcesResult,
  ResourceMetadata,
  TeardownCandidate,
  TeardownEnumeration,
  TeardownHole,
} from "@intentius/chant/lexicon";
import {
  mergeObservations,
  normalizeObservation,
  observation,
  observeEntities,
  type DeclaredEntity,
  type EntityObservation,
  type ObserverAdapter,
  type RootRead,
  type UnobservedReason,
} from "@intentius/chant/observation";
import type { OwnershipMarker } from "@intentius/chant/ownership";
import {
  rollupInstances,
  terraformInstancePath,
  TERRAFORM_INSTANCE_ROLLUP,
  type InstanceObservation,
} from "@intentius/chant/instance-nodes";
import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  choudoufuLiveLs,
  choudoufuLivePlanDocument,
  terraformInit,
  terraformPlanRead,
  terraformShow,
  TerraformPlanReadError,
} from "./op/activities/terraform";
import { blockAddressOf, indexPlan, planAttributesFor, plannedAttributesFor, type PlanIndex } from "./plan-observation";
import type { TerraformObserveDepth } from "./config";
import { LIVE_PLAN_OMISSION_REASONS, readsAsCredentials } from "./live-plan-reasons";
import { DATA_TYPE, MODULE_TYPE, RESOURCE_TYPE, callersOfKey } from "./hcl/parse";

// The channel keys live in their own module so `plugin.ts` can declare
// `ownershipChannel` without loading this reader. Re-exported here because
// this is where they are used.
export { TERRAFORM_STATE_OWNERSHIP_KEYS } from "./state-ownership";
export { TERRAFORM_LIVE_MARKER_KEYS } from "./live-ownership";
export { LIVE_PLAN_OMISSION_REASONS } from "./live-plan-reasons";

/** One row out of `values.root_module.resources[]`, at any module depth. */
export interface StateResourceRow {
  /** Fully qualified terraform address, `module.<name>.` prefixes included. */
  address: string;
  /** `managed` for a `resource` block, `data` for a `data` block. */
  mode?: string;
  /** Resource type, e.g. `null_resource`. */
  type?: string;
  /** Provider that owns the row, e.g. `registry.terraform.io/hashicorp/null`. */
  providerName?: string;
  /** `values.id`, when the row carries a string id. Nothing else from `values` is read. */
  id?: string;
}

/** What one root's state read produced. */
export interface StateIndex {
  /** Every resource/data row, keyed by fully qualified address. */
  rows: Map<string, StateResourceRow>;
  /** Every `module.<name>` address the state carries a child module for, at any depth. */
  modules: Set<string>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Index a `terraform show -json` document by address.
 *
 * Terraform already writes fully qualified addresses inside `child_modules`
 * (`module.cdn.null_resource.edge`, as `src/__fixtures__/show-state.json`
 * records), so the module prefix is applied only when a row's own address is
 * missing it. Belt and braces for an older `format_version`, never a second
 * `module.cdn.` on top of the first.
 */
export function indexStateResources(showJson: unknown): StateIndex {
  const rows = new Map<string, StateResourceRow>();
  const modules = new Set<string>();

  const walk = (module: unknown, prefix: string): void => {
    const node = asRecord(module);
    for (const entry of asArray(node.resources)) {
      const row = asRecord(entry);
      const raw = asString(row.address);
      if (!raw) continue;
      const address = prefix && !raw.startsWith(`${prefix}.`) ? `${prefix}.${raw}` : raw;
      rows.set(address, {
        address,
        ...(asString(row.mode) ? { mode: asString(row.mode) } : {}),
        ...(asString(row.type) ? { type: asString(row.type) } : {}),
        ...(asString(row.provider_name) ? { providerName: asString(row.provider_name) } : {}),
        ...(asString(asRecord(row.values).id) ? { id: asString(asRecord(row.values).id) } : {}),
      });
    }
    for (const entry of asArray(node.child_modules)) {
      const child = asRecord(entry);
      const address = asString(child.address) ?? prefix;
      if (address) modules.add(address);
      walk(child, address ?? "");
    }
  };

  walk(asRecord(asRecord(showJson).values).root_module, "");
  return { rows, modules };
}

/**
 * The ownership verdict for one declared address: `owned` when the state
 * carries a row for it, `unknown` otherwise. Exported because it is the whole
 * of terraform's ownership channel, and a channel with one rule deserves one
 * function to point at.
 */
export function classifyStateOwnership(address: string, index: StateIndex): "owned" | "unknown" {
  return index.rows.has(address) ? "owned" : "unknown";
}

/**
 * True when `instance` is the module call `address` itself or sits beneath it,
 * at any instance key. `address` is a declared module address with no keys
 * (`module.app`, `module.outer.module.inner`); a state or live-plan address
 * carries them (`module.app[0]`, `module.outer["a"].module.inner[1].aws_eip.x`),
 * so the keys come off before the prefix test (#4513).
 */
function underModule(instance: string, address: string): boolean {
  const block = blockAddressOf(instance);
  return block === address || block.startsWith(`${address}.`);
}

/** True when the state carries at least one resource beneath `module.<name>`. */
function moduleIsLive(address: string, index: StateIndex): boolean {
  // A keyed call's child_modules[] entries are `module.app[0]`, never
  // `module.app`, and so are its rows' prefixes (#4513).
  for (const module of index.modules) if (underModule(module, address)) return true;
  for (const key of index.rows.keys()) if (underModule(key, address)) return true;
  return false;
}

/* ─────────────────────────── live roots (#2104) ─────────────────────────── */

/** One `bound[]` entry: a declared instance the plan admitted into prior state. */
export interface LivePlanBoundRow {
  addr: string;
  type?: string;
  /** The import id it bound to, when the resolver produced one. */
  identity?: string;
  /** Which admission path supplied the identity: `marker`, `record`, `derived` or `cache`. */
  source?: string;
}

/** One `omissions[]` entry: a declared instance the plan could not read, and why. */
export interface LivePlanOmissionRow {
  addr: string;
  /** choudoufu's own machine-readable code (`ABSENT`, `FAILED`, `UNOWNED`, …). */
  reason: string;
  detail: string;
}

/** One `unowned[]` entry: a live resource at a declared identity without this estate's marker. */
export interface LivePlanUnownedRow {
  addr: string;
  type?: string;
  identity?: string;
  /** `tofu_estate`: the marker it does carry, when it carries one. Empty means no marker at all. */
  heldBy?: string;
  /** `adopt_tofu_estate`: present exactly when adoption is this run's to offer. */
  adoptEstate?: string;
  /** `adopt_tofu_address`: the escaped address the adopting tag write would carry. */
  adoptAddress?: string;
}

/**
 * One `adoptable[]` entry: a live resource the estate-wide sweep matched to a
 * declared instance by content rather than by reading a declared identity
 * (choudoufu #962). The declaration names no identity at all, so this is the
 * only row the document has for it and the paired omission says
 * `NEEDS_DISCOVERY`.
 *
 * Same fields as {@link LivePlanUnownedRow} minus `heldBy`, which cannot
 * apply: a row here carries no marker for any estate, or the sweep would have
 * called it foreign instead of unclaimed.
 */
export interface LivePlanAdoptableRow {
  addr: string;
  type?: string;
  identity?: string;
  adoptEstate?: string;
  adoptAddress?: string;
  /** `matched[]`: the arguments the declaration and the live resource agreed on exactly. */
  matched?: Array<{ attribute: string; value: string }>;
}

/** A `live-plan -json` document, indexed by declared instance address. */
export interface LivePlanIndex {
  /** `estate`: the estate every section was computed against. */
  estate: string;
  bound: Map<string, LivePlanBoundRow>;
  omissions: Map<string, LivePlanOmissionRow>;
  unowned: Map<string, LivePlanUnownedRow>;
  adoptable: Map<string, LivePlanAdoptableRow>;
  /**
   * `swept[]`: the resource types the estate-wide sweep listed in full. Empty
   * on every observation read, which asks for no sweep, so an empty
   * `adoptable` beside it says nothing was asked rather than nothing found.
   */
  swept: string[];
  /** Every address any section named, so a block can find its own instances. */
  addresses: string[];
  /** `diagnostics[]` summaries, for the observation's run-level notes. */
  diagnostics: string[];
}

/**
 * Index choudoufu issue #788's document. Unknown fields are ignored and a
 * missing section reads as empty: a document from a newer choudoufu must
 * degrade to "this section said nothing", never to a throw.
 */
export function indexLivePlan(document: unknown): LivePlanIndex {
  const doc = asRecord(document);
  const index: LivePlanIndex = {
    estate: asString(doc.estate) ?? "",
    bound: new Map(),
    omissions: new Map(),
    unowned: new Map(),
    adoptable: new Map(),
    swept: asArray(doc.swept).filter((t): t is string => typeof t === "string"),
    addresses: [],
    diagnostics: [],
  };

  for (const entry of asArray(doc.bound)) {
    const row = asRecord(entry);
    const addr = asString(row.addr);
    if (!addr) continue;
    index.bound.set(addr, {
      addr,
      ...(asString(row.type) ? { type: asString(row.type) } : {}),
      ...(asString(row.identity) ? { identity: asString(row.identity) } : {}),
      ...(asString(row.source) ? { source: asString(row.source) } : {}),
    });
  }

  for (const entry of asArray(doc.omissions)) {
    const row = asRecord(entry);
    const addr = asString(row.addr);
    if (!addr) continue;
    index.omissions.set(addr, {
      addr,
      reason: asString(row.reason) ?? "",
      detail: asString(row.detail) ?? "",
    });
  }

  for (const entry of asArray(doc.unowned)) {
    const row = asRecord(entry);
    const addr = asString(row.addr);
    if (!addr) continue;
    index.unowned.set(addr, {
      addr,
      ...(asString(row.type) ? { type: asString(row.type) } : {}),
      ...(asString(row.identity) ? { identity: asString(row.identity) } : {}),
      ...(asString(row.tofu_estate) ? { heldBy: asString(row.tofu_estate) } : {}),
      ...(asString(row.adopt_tofu_estate) ? { adoptEstate: asString(row.adopt_tofu_estate) } : {}),
      ...(asString(row.adopt_tofu_address) ? { adoptAddress: asString(row.adopt_tofu_address) } : {}),
    });
  }

  for (const entry of asArray(doc.adoptable)) {
    const row = asRecord(entry);
    const addr = asString(row.addr);
    if (!addr) continue;
    const matched = asArray(row.matched)
      .map((m) => asRecord(m))
      .filter((m) => asString(m.attribute))
      .map((m) => ({ attribute: asString(m.attribute)!, value: asString(m.value) ?? "" }));
    index.adoptable.set(addr, {
      addr,
      ...(asString(row.type) ? { type: asString(row.type) } : {}),
      ...(asString(row.identity) ? { identity: asString(row.identity) } : {}),
      ...(asString(row.adopt_tofu_estate) ? { adoptEstate: asString(row.adopt_tofu_estate) } : {}),
      ...(asString(row.adopt_tofu_address) ? { adoptAddress: asString(row.adopt_tofu_address) } : {}),
      ...(matched.length > 0 ? { matched } : {}),
    });
  }

  for (const entry of asArray(doc.diagnostics)) {
    const row = asRecord(entry);
    const summary = asString(row.summary);
    if (summary) index.diagnostics.push(`${asString(row.severity) ?? "warning"}: ${summary}`);
  }

  index.addresses = [
    ...new Set([
      ...index.bound.keys(),
      ...index.omissions.keys(),
      ...index.unowned.keys(),
      ...index.adoptable.keys(),
    ]),
  ].sort();
  return index;
}

/** The chant verdict for one omission: `no-credentials` when its detail says so. */
function omissionVerdict(row: LivePlanOmissionRow): UnobservedReason | "absent" {
  const mapped = LIVE_PLAN_OMISSION_REASONS[row.reason] ?? "read-failed";
  if (mapped === "read-failed" && readsAsCredentials(row.detail)) return "no-credentials";
  return mapped;
}

/**
 * Every instance address in the document belonging to the declared block
 * `address`. Exported for the behaviour request builder (`./behaviour/`,
 * #2360), which places the same blocks against the same document.
 */
export function instancesOf(address: string, index: LivePlanIndex): string[] {
  // `blockAddressOf` strips every key, so an instance under an expanded
  // module call (`module.app[0].aws_eip.pool[1]`) is the block's too (#4488).
  return index.addresses.filter((a) => a === address || a.startsWith(`${address}[`) || blockAddressOf(a) === address);
}

/** True when the document names any instance under `module.<name>`, at any depth. */
function liveModuleMembers(address: string, index: LivePlanIndex): string[] {
  // Keys stripped first, so a nested call under a keyed one
  // (`module.outer[0].module.inner["a"].…`) is a member too (#4513).
  return index.addresses.filter((a) => underModule(a, address));
}

/** One instance's verdict, before a block aggregates its instances. */
export type InstanceVerdict =
  | { kind: "owned"; row: LivePlanBoundRow }
  | { kind: "adoptable"; row: LivePlanAdoptableRow }
  | { kind: "foreign"; row: LivePlanUnownedRow }
  | { kind: "absent" }
  | { kind: "unobserved"; reason: UnobservedReason; detail: string };

/**
 * Classify one instance address against the document, `unowned[]` first: a
 * declared instance that also carries a `UNOWNED` omission is answered by the
 * section that has the verdict, not by the one that has the apology.
 * `adoptable[]` sits under `bound[]` for the same reason, one rung further
 * down: a content match is the answer for an instance nothing else could
 * answer for, and its paired omission is always `NEEDS_DISCOVERY`, which on
 * its own would read as unsupported-kind and hide a real, actionable verdict
 * (choudoufu #962, chant #2241).
 */
export function classifyLiveInstance(address: string, index: LivePlanIndex): InstanceVerdict {
  const unowned = index.unowned.get(address);
  if (unowned) {
    return unowned.adoptEstate || unowned.adoptAddress
      ? { kind: "adoptable", row: unowned }
      : { kind: "foreign", row: unowned };
  }

  const bound = index.bound.get(address);
  if (bound) return { kind: "owned", row: bound };

  const matched = index.adoptable.get(address);
  if (matched && (matched.adoptEstate || matched.adoptAddress)) {
    return { kind: "adoptable", row: matched };
  }

  const omission = index.omissions.get(address);
  if (omission) {
    const verdict = omissionVerdict(omission);
    if (verdict === "absent") return { kind: "absent" };
    return {
      kind: "unobserved",
      reason: verdict,
      detail: `${address}: ${omission.reason}${omission.detail ? ` — ${omission.detail}` : ""}`,
    };
  }

  return { kind: "absent" };
}

/**
 * Where one instance address of the declared block `address` sits: its own
 * key and the expanded module path (`@intentius/chant/instance-nodes`), or
 * undefined when it is the block's unexpanded address or another block's.
 * An instance under an expanded module call carries `scope` (#4488), so the
 * live graph draws it under the same id the declared graph lists.
 */
function instanceKeyAndScope(address: string, instance: string): { key?: string; scope?: string } | undefined {
  if (instance === address || blockAddressOf(instance) !== address) return undefined;
  const path = terraformInstancePath(instance);
  if (!path) return undefined;
  return { ...(path.key !== undefined ? { key: path.key } : {}), ...(path.scope !== undefined ? { scope: path.scope } : {}) };
}

/**
 * Each instance's own verdict (#4454), keyed as Terraform prints it, for the
 * block's `instances`. An instance under an expanded module call carries its
 * module path as `scope` (#4488) and its own key when the block is expanded too.
 */
function liveInstanceObservations(address: string, instances: readonly string[], verdicts: readonly InstanceVerdict[]): InstanceObservation[] {
  const out: InstanceObservation[] = [];
  instances.forEach((a, i) => {
    const at = instanceKeyAndScope(address, a);
    if (at === undefined) return;
    const v = verdicts[i]!;
    switch (v.kind) {
      case "owned":
        out.push({ ...at, address: a, verdict: "present", ownership: "owned", status: "bound", ...(v.row.identity ? { physicalId: v.row.identity } : {}) });
        break;
      case "foreign":
        out.push({ ...at, address: a, verdict: "present", ownership: "foreign", status: "unowned", ...(v.row.identity ? { physicalId: v.row.identity } : {}) });
        break;
      case "adoptable":
        out.push({ ...at, address: a, verdict: "present", ownership: "unknown", status: "adoptable", ...(v.row.identity ? { physicalId: v.row.identity } : {}) });
        break;
      case "absent":
        out.push({ ...at, address: a, verdict: "absent" });
        break;
      case "unobserved":
        out.push({ ...at, address: a, verdict: "not-observed", reason: v.reason, detail: v.detail });
        break;
    }
  });
  return out;
}

/**
 * The declared block's verdict, aggregated over its instances in the
 * precedence the module doc states: not-observed, then foreign, then
 * adoptable, then owned, and all-absent last. A block whose instances are
 * only partly known is not partly owned; it is unknown, which never becomes
 * a delete.
 */
function readLiveResource(
  entity: TerraformDeclared,
  index: LivePlanIndex,
  root: string,
  queried: string,
): EntityObservation {
  const { address } = entity;
  const instances = instancesOf(address, index);
  if (instances.length === 0) return { absent: true, queried };

  const verdicts = instances.map((a) => classifyLiveInstance(a, index));
  const attributes: Record<string, unknown> = { address, root, estate: index.estate };
  const expanded = instances.length > 1 || instances[0] !== address;
  if (expanded) attributes.instances = instances;
  const perInstance = expanded ? liveInstanceObservations(address, instances, verdicts) : [];
  const withInstances = perInstance.length > 0 ? { instances: perInstance } : {};

  const top = rollupInstances(verdicts, TERRAFORM_INSTANCE_ROLLUP);

  if (top?.kind === "unobserved") {
    return { unobserved: { reason: top.reason, detail: top.detail }, queried };
  }

  const foreign = top;
  if (foreign?.kind === "foreign") {
    return {
      present: {
        ...withInstances,
        type: entity.type,
        physicalId: foreign.row.identity ?? address,
        status: "unowned",
        ownership: "foreign",
        attributes: {
          ...attributes,
          ...(foreign.row.type ? { resourceType: foreign.row.type } : {}),
          ...(foreign.row.heldBy ? { heldBy: foreign.row.heldBy } : {}),
        },
      },
      queried,
    };
  }

  const adoptable = top;
  if (adoptable?.kind === "adoptable") {
    // `unknown`, not `foreign`: the resource matches the declaration and one
    // tag write claims it. The two values that write carries are the whole
    // adoption proposal #2105 builds its Op on, so they ride the metadata
    // rather than being re-derived from the address there. No `marker` is
    // surfaced, because nothing was read off this resource: it carries none.
    return {
      present: {
        ...withInstances,
        type: entity.type,
        physicalId: adoptable.row.identity ?? address,
        status: "adoptable",
        ownership: "unknown",
        attributes: {
          ...attributes,
          ...(adoptable.row.type ? { resourceType: adoptable.row.type } : {}),
          ...(adoptable.row.adoptEstate ? { adoptTofuEstate: adoptable.row.adoptEstate } : {}),
          ...(adoptable.row.adoptAddress ? { adoptTofuAddress: adoptable.row.adoptAddress } : {}),
          // Present only on a content match: the arguments the sweep compared,
          // which is the whole evidence for a match nobody read an identity
          // for, and the thing an operator checks before letting a tag write
          // claim the resource.
          ...(adoptable.row.matched?.length
            ? { matchedOn: adoptable.row.matched.map((m) => `${m.attribute}=${m.value}`) }
            : {}),
        },
      },
      queried,
    };
  }

  if (top?.kind !== "owned") return { absent: true, queried };
  const owned = verdicts.filter((v) => v.kind === "owned") as Array<{ kind: "owned"; row: LivePlanBoundRow }>;

  const sources = [...new Set(owned.map((v) => v.row.source ?? "unknown"))].sort();
  const byMarker = sources.length === 1 && sources[0] === "marker";
  return {
    present: {
      ...withInstances,
      type: entity.type,
      physicalId: owned.length === 1 ? (owned[0]!.row.identity ?? address) : address,
      status: "bound",
      ownership: "owned",
      // The marker is surfaced only where one was actually read. A `derived`
      // bind computed the identity from the configuration and looked at no
      // tag, so claiming a marker for it would be a guess.
      ...(byMarker ? { marker: { stack: index.estate } as OwnershipMarker } : {}),
      attributes: {
        ...attributes,
        ...(owned[0]!.row.type ? { resourceType: owned[0]!.row.type } : {}),
        boundBy: sources.join(","),
      },
    },
    queried,
  };
}

/**
 * The environment variable that asks for each live root's `live-plan -json`
 * document as a file, in a directory the caller owns (behold#924).
 *
 * The overlay keeps chant's verdict per block and drops the rows behind it:
 * each instance's omission reason and detail, `identity_values`, the adoptable
 * row's own fields. A caller that paints ownership from those rows and wants
 * the plan's attributes from the plan depth would otherwise run its own
 * `live-plan` beside this one, two refreshes of the estate that can disagree
 * (choudoufu #1014). With this set to an absolute directory, the document this
 * read used is written there as `<root>.live-plan.json`, so the caller reads
 * the same `live-plan` the verdicts came from.
 *
 * Opt-in, and never inside the root: a relative path is ignored, so nothing
 * lands in the root by accident (#4379). A write that fails is ignored too;
 * the read answers either way, and the caller sees no file.
 */
export const TERRAFORM_LIVE_PLAN_DIR_ENV = "CHANT_TERRAFORM_LIVE_PLAN_DIR";

/** The file {@link TERRAFORM_LIVE_PLAN_DIR_ENV} names for a root: the root's name, made safe for a file name. */
export function livePlanDocumentFile(root: string): string {
  return `${root.replace(/[^A-Za-z0-9._-]/g, "_")}.live-plan.json`;
}

/** Write a live root's document where {@link TERRAFORM_LIVE_PLAN_DIR_ENV} asks, if it asks. */
function handLivePlanDocument(root: string, json: unknown): void {
  const out = process.env[TERRAFORM_LIVE_PLAN_DIR_ENV];
  if (!out || !isAbsolute(out)) return;
  try {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, livePlanDocumentFile(root)), JSON.stringify(json));
  } catch {
    // Best effort: the read's answer does not depend on the copy.
  }
}

/**
 * One live root's reader: `live-plan -json`, then address matching against
 * the document. `terraform show` is never run here, and there is no state
 * file to run it over.
 */
function liveAdapter(root: string, cwd: string | undefined, deps: TerraformReadDeps): ObserverAdapter<LivePlanIndex> {
  const where = cwd ? { cwd } : {};
  let dir: string | undefined;

  return {
    async bind(): Promise<LivePlanIndex> {
      const planned = await deps.livePlan({ root, ...where });
      dir = planned.dir;
      handLivePlanDocument(root, planned.json);
      return indexLivePlan(planned.json);
    },

    classifyBindFailure(err) {
      const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
      const full = err instanceof Error ? err.message : String(err);
      return {
        reason: readsAsCredentials(full) ? "no-credentials" : "read-failed",
        detail: `terraform.roots.${root}${dir ? ` (${dir})` : ""}: ${message}`,
      };
    },

    async read(index, entity): Promise<EntityObservation> {
      const declared = entity as TerraformDeclared;
      const { address } = declared;
      const queried = `choudoufu live-plan -json (root "${root}", estate "${index.estate}", address "${address}")`;

      if (entity.type === RESOURCE_TYPE) return readLiveResource(declared, index, root, queried);

      if (entity.type === DATA_TYPE) {
        return {
          unobserved: {
            reason: "unsupported-kind",
            detail:
              "live-plan's document is prior state for managed resources; a data block has no row in bound, omissions or unowned",
          },
          queried,
        };
      }

      if (entity.type === MODULE_TYPE) {
        const members = liveModuleMembers(address, index);
        if (members.length === 0) return { absent: true, queried };
        // Same shape as the stock reader's module answer, for the same
        // reason: the document names the module's resources and never the
        // block itself, so the ownership channel has nothing to say about it.
        return {
          present: {
            type: entity.type,
            physicalId: address,
            status: "module",
            ownership: "unknown",
            attributes: { address, root, estate: index.estate, instances: members },
          },
          queried,
        };
      }

      return {
        unobserved: {
          reason: "unsupported-kind",
          detail: `${entity.type} has no row in a live-plan document: only resource blocks do`,
        },
        queried,
      };
    },
  };
}

/* ──────────────────── the estate beyond the declaration ─────────────────── */

/** One `items[]` entry of a `live-ls -json` listing. */
export interface LiveLsItem {
  /** ARN or other stable identity. */
  id: string;
  /** Resource type, e.g. `aws_vpc`. */
  type: string;
  /** The configuration address decoded from the marker, when the listing could decode one. */
  address?: string;
  /** `tofu-slot`, on a `count` instance. */
  slot?: string;
  /** Whether the cross-referenced configuration directory still declares it. */
  declared: boolean;
  /** Which read found it: `tagging`, or a per-service pass. */
  source?: string;
  /** Every marker tag it carries. */
  tags: Record<string, string>;
}

/** One `gaps[]` entry: a declared instance this listing's mechanism cannot reach. */
export interface LiveLsGap {
  address: string;
  type: string;
  /** `record` or `declaration-carried`, choudoufu's own rung vocabulary. */
  rung: string;
  detail: string;
}

/** A `live-ls -json` listing, parsed. */
export interface LiveLsListing {
  estate: string;
  items: LiveLsItem[];
  gaps: LiveLsGap[];
}

/** Parse a `live-ls -json` document. A missing section reads as empty, never as a throw. */
export function readLiveLs(document: unknown): LiveLsListing {
  const doc = asRecord(document);
  const items: LiveLsItem[] = [];
  for (const entry of asArray(doc.items)) {
    const row = asRecord(entry);
    const id = asString(row.id);
    const type = asString(row.type);
    if (!id || !type) continue;
    const tags: Record<string, string> = {};
    for (const [key, value] of Object.entries(asRecord(row.tags))) {
      if (typeof value === "string") tags[key] = value;
    }
    items.push({
      id,
      type,
      ...(asString(row.address) ? { address: asString(row.address) } : {}),
      ...(asString(row.slot) ? { slot: asString(row.slot) } : {}),
      declared: row.declared === true,
      ...(asString(row.source) ? { source: asString(row.source) } : {}),
      tags,
    });
  }

  const gaps: LiveLsGap[] = [];
  for (const entry of asArray(doc.gaps)) {
    const row = asRecord(entry);
    const address = asString(row.address);
    if (!address) continue;
    gaps.push({
      address,
      type: asString(row.type) ?? "",
      rung: asString(row.rung) ?? "",
      detail: asString(row.detail) ?? "",
    });
  }

  return { estate: asString(doc.estate) ?? "", items, gaps };
}

/**
 * A live-ls gap's rung, mapped onto chant's vocabulary. Both rungs mean the
 * same thing to a reader of the listing: this instance can never appear in
 * it, because the mechanism the listing uses cannot reach it. That is
 * `unsupported-kind`, not a failure and not an absence.
 */
function gapReason(): UnobservedReason {
  return "unsupported-kind";
}

/**
 * The entity key `buildRoots()` would have produced for a live resource's
 * address.
 *
 * A live address is fully qualified with dots, `module.cdn.null_resource.edge`;
 * the build keys a descended child module's block with a slash per call,
 * `app/module.cdn/null_resource.edge` (#2112). Splitting the `module.<name>.`
 * prefixes back out is what keeps a live row and the block that declared it
 * on the same key.
 */
export function entityKeyFor(root: string, address: string): string {
  const parts = address.split(".");
  const segments: string[] = [];
  let i = 0;
  while (i + 1 < parts.length && parts[i] === "module") {
    segments.push(`module.${parts[i + 1]}`);
    i += 2;
  }
  segments.push(parts.slice(i).join("."));
  return [root, ...segments].join("/");
}

/**
 * The entity types this lexicon can enumerate beyond the declared estate
 * (#1278). One: a `resource` block, whose live counterparts `live-ls` lists
 * off the tag index. A `data`, `module` or `provider` block has no live
 * counterpart to enumerate at all.
 */
export function ambientKinds(): string[] {
  return [RESOURCE_TYPE];
}

/** Shared options for the two estate-wide reads. */
export interface LiveEstateOptions {
  /** Directory the activities start the `chant.config.*` search from. Default: the process cwd. */
  cwd?: string;
  /** Restrict to these root names. Default: every live root the project declares. */
  roots?: string[];
}

/**
 * Every live root the project declares, in config order, leaving out a
 * `signalOnly` one (#4484). Reads the project
 * config the same way the activities do, so `terraform.roots` is read once
 * and the same answer reaches both.
 */
export async function liveRootNames(cwd?: string): Promise<Array<{ root: string; estate: string }>> {
  const { loadChantConfigUpward } = await import("@intentius/chant/config");
  const { detectLiveEstate } = await import("./op/activities/live-detect");
  const { dirname, resolve } = await import("node:path");

  const start = resolve(cwd ?? process.cwd());
  const { config, configPath } = await loadChantConfigUpward(start);
  const projectRoot = configPath ? dirname(configPath) : start;
  const namespace = (config as { terraform?: { binary?: string; roots?: Record<string, { dir: string; signalOnly?: boolean }> } })
    .terraform;
  if (namespace?.binary !== "choudoufu") return [];

  const live: Array<{ root: string; estate: string }> = [];
  for (const [name, root] of Object.entries(namespace.roots ?? {})) {
    // A `signalOnly` root (#4484) is another project's: it only brings this one into a change.
    if (root.signalOnly === true) continue;
    const estate = detectLiveEstate(resolve(projectRoot, root.dir));
    if (estate !== undefined) live.push({ root: name, estate });
  }
  return live;
}

/**
 * Report the resources this estate owns that nothing declares (#1278) — the
 * owned-orphan set, which is `live-ls`'s `declared: false` rows.
 *
 * This is the question a state file cannot answer at all, because a state
 * file knows only what it created. The tag index knows what the estate holds,
 * whether or not any configuration still mentions it.
 */
export async function observeAmbient(
  options: {
    environment: string;
    kinds: string[];
    observed: Record<string, ResourceMetadata>;
  } & LiveEstateOptions,
  deps: TerraformReadDeps = REAL_DEPS,
): Promise<Record<string, ResourceMetadata>> {
  // The bound #1278 asks for: a project that declares no terraform resources
  // is never made to enumerate an estate.
  if (!options.kinds.includes(RESOURCE_TYPE)) return {};

  const out: Record<string, ResourceMetadata> = {};
  for (const { root, estate } of await liveRoots(options)) {
    const listed = await deps.liveLs({
      root,
      consistent: true,
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });
    const listing = readLiveLs(listed.json);
    for (const item of listing.items) {
      if (item.declared) continue; // declared is `describeResources`'s business, not this one's
      const address = item.address ?? item.id;
      const name = entityKeyFor(root, address);
      if (options.observed[name]) continue;
      out[name] = {
        type: RESOURCE_TYPE,
        physicalId: item.id,
        status: "orphan",
        ownership: "owned",
        marker: { stack: listing.estate || estate },
        ambient: true,
        attributes: {
          address,
          root,
          estate: listing.estate || estate,
          resourceType: item.type,
          ...(item.slot ? { slot: item.slot } : {}),
          ...(item.source ? { listedBy: item.source } : {}),
          tags: item.tags,
        },
      };
    }
  }
  return out;
}

/**
 * Name what a teardown of this environment would remove from every live root
 * (#1222): the estate's owned orphans, which are exactly the set choudoufu's
 * own default `policy` verb (`undeclared_tagged = "delete"`) removes on the
 * next apply.
 *
 * Candidates carry the requested identity verbatim, because that identity is
 * what selected them: the roots enumerated here are this project's own, and
 * their estates are what `terraform.roots` declares for this environment.
 * The estate that actually answered rides `name`, so a reviewer of the plan
 * can see which one it was.
 *
 * `live-ls`'s own `gaps[]` become holes rather than silence, per #1089: a
 * declared instance the tag index can never serve is unknown, not clean.
 */
export async function teardownOwned(
  options: { environment: string; marker: OwnershipMarker } & LiveEstateOptions,
  deps: TerraformReadDeps = REAL_DEPS,
): Promise<TeardownEnumeration> {
  const candidates: TeardownCandidate[] = [];
  const holes: TeardownHole[] = [];

  for (const { root, estate } of await liveRoots(options)) {
    let listing: LiveLsListing;
    try {
      const listed = await deps.liveLs({
        root,
        consistent: true,
        ...(options.cwd ? { cwd: options.cwd } : {}),
      });
      listing = readLiveLs(listed.json);
    } catch (err) {
      // Nothing was read, so nothing is known about this root's estate. A
      // hole, never an empty candidate list, which would read as "clean".
      holes.push({
        name: `terraform.roots.${root}`,
        reason: "read-failed",
        detail: `choudoufu live-ls (estate "${estate}"): ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    for (const item of listing.items) {
      if (item.declared) continue;
      candidates.push({
        name: entityKeyFor(root, item.address ?? item.id),
        type: RESOURCE_TYPE,
        physicalId: item.id,
        marker: options.marker,
      });
    }

    for (const gap of listing.gaps) {
      holes.push({
        name: entityKeyFor(root, gap.address),
        type: RESOURCE_TYPE,
        reason: gapReason(),
        detail: `${gap.rung}: ${gap.detail}`,
      });
    }
  }

  return { candidates, ...(holes.length > 0 ? { holes } : {}) };
}

/** The live roots an estate-wide read runs over: the caller's list, or every one declared. */
async function liveRoots(options: LiveEstateOptions): Promise<Array<{ root: string; estate: string }>> {
  const declared = await liveRootNames(options.cwd);
  if (!options.roots) return declared;
  const wanted = new Set(options.roots);
  return declared.filter((entry) => wanted.has(entry.root));
}

/* ─────────────────────────────── dispatch ───────────────────────────────── */

/** The activities this reader drives. Injectable so tests never run a binary. */
export interface TerraformReadDeps {
  init: typeof terraformInit;
  show: typeof terraformShow;
  /** The document alone (chant #2498): this reader indexes it and never reads the human render. */
  livePlan: typeof choudoufuLivePlanDocument;
  liveLs: typeof choudoufuLiveLs;
  /**
   * The plan depth's read (#4358). Optional so a test that never asks for the
   * plan depth need not stub it; omitted, the real activity runs.
   */
  planRead?: typeof terraformPlanRead;
}

const REAL_DEPS: TerraformReadDeps = {
  init: terraformInit,
  show: terraformShow,
  livePlan: choudoufuLivePlanDocument,
  liveLs: choudoufuLiveLs,
  planRead: terraformPlanRead,
};

/** A declared entity, plus the root, address and mode `buildRoots()` recorded on it. */
export interface TerraformDeclared extends DeclaredEntity {
  root: string;
  address: string;
  /** `"live"` when the root runs under choudoufu with a declared estate (#2103). */
  mode?: string;
}

/**
 * Split a `<root>/<address>` entity key, or a descended child module's
 * `<root>/module.<name>/<address>` (#2112). Only a fallback: `buildRoots()`
 * records the root, the address and the call chain on `props`, and a
 * duplicated address is keyed `…~2` there, so the props are the reliable
 * source.
 */
function fromEntityName(name: string): { root: string; address: string; callers: string[] } {
  const slash = name.indexOf("/");
  if (slash === -1) return { root: "", address: name, callers: [] };
  const last = name.lastIndexOf("/");
  return {
    root: name.slice(0, slash),
    address: name.slice(last + 1).replace(/~\d+$/, ""),
    callers: callersOfKey(name),
  };
}

/**
 * The address the live system knows a block by. For a root-module block that
 * is the block's own address; for one inside a child module it is what
 * `terraform show -json` writes in `child_modules[]` and what choudoufu's
 * markers carry, the call chain and the address joined with dots:
 * `module.cdn.null_resource.edge` (#2112). The entity KEY keeps its slashes
 * (`app/module.cdn/null_resource.edge`), so what a build declares and what a
 * read observes still line up one to one.
 */
export function qualifiedAddress(address: string, callers: readonly string[]): string {
  return callers.length === 0 ? address : `${callers.join(".")}.${address}`;
}

/**
 * The root, qualified address and mode of one declared entity, from what
 * `buildRoots()` recorded on its props. Exported for the behaviour request
 * builder (#2360), which groups entities by root the same way.
 */
export function declaredOf(name: string, entity: { entityType: string; props: Record<string, unknown> } | undefined): TerraformDeclared {
  const props = entity?.props ?? {};
  const fallback = fromEntityName(name);
  const callers = Array.isArray(props.callers)
    ? (props.callers as unknown[]).filter((c): c is string => typeof c === "string")
    : fallback.callers;
  return {
    name,
    type: entity?.entityType ?? "",
    props,
    root: asString(props.root) ?? fallback.root,
    address: qualifiedAddress(asString(props.address) ?? fallback.address, callers),
    ...(asString(props.mode) ? { mode: asString(props.mode) } : {}),
  };
}

/**
 * One root's reader: `init`, then `show` over state, then address matching.
 * The entity-level reads are {@link readStateEntity}, which the plan depth's
 * fallback shares.
 */
function adapter(root: string, cwd: string | undefined, deps: TerraformReadDeps): ObserverAdapter<StateIndex> {
  const where = cwd ? { cwd } : {};
  let dir: string | undefined;

  return {
    async bind(): Promise<StateIndex> {
      // `init` first: `show` against an uninitialized root reports no state at
      // all, which would read as "everything is absent", the exact failure
      // the tri-state exists to prevent.
      const initialized = await deps.init({ root, ...where });
      dir = initialized.dir;
      const shown = await deps.show({ root, ...where });
      dir = shown.dir;
      return indexStateResources(shown.json);
    },

    classifyBindFailure(err) {
      const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
      return {
        reason: "read-failed",
        detail: `terraform.roots.${root}${dir ? ` (${dir})` : ""}: ${message}`,
      };
    },

    async read(index, entity): Promise<EntityObservation> {
      return readStateEntity(index, entity, root, `terraform show -json (root "${root}", address "${(entity as TerraformDeclared).address}")`);
    },
  };
}

/** True when the index carries any row for the block `address`, at any instance key. */
function blockRows(address: string, index: StateIndex): StateResourceRow[] {
  const exact = index.rows.get(address);
  if (exact) return [exact];
  return [...index.rows.values()].filter((row) => blockAddressOf(row.address) === address);
}

/**
 * Each row of an expanded block as an instance (#4454), keyed as Terraform
 * prints it. A state row is a recorded instance, owned by membership. A row
 * under an expanded module call carries its module path as `scope`, as on
 * the live read (#4488).
 */
function stateInstanceObservations(address: string, rows: readonly StateResourceRow[]): InstanceObservation[] {
  const out: InstanceObservation[] = [];
  for (const r of rows) {
    const at = instanceKeyAndScope(address, r.address);
    if (at === undefined) continue;
    out.push({ ...at, address: r.address, verdict: "present", ownership: "owned", status: r.mode ?? "managed", ...(r.id ? { physicalId: r.id } : {}) });
  }
  return out.sort((a, b) => a.address.localeCompare(b.address));
}

/**
 * One declared entity against a state index: the state read's whole verdict,
 * and the plan depth's too, since a plan's `prior_state` is the same shape.
 * `extra` is what the plan depth adds to a present resource or data block.
 */
function readStateEntity(
  index: StateIndex,
  entity: DeclaredEntity,
  root: string,
  queried: string,
  extra?: (address: string) => Record<string, unknown>,
): EntityObservation {
  const { address } = entity as TerraformDeclared;

  if (entity.type === RESOURCE_TYPE || entity.type === DATA_TYPE) {
    // The exact row first, which is the state read's rule since #2087, then
    // a `count` or `for_each` block by its instances: the plan depth did
    // that from the start, and the state read does since #4454, which is
    // what gives a drift row for `aws_eip.pool[0]` a block to roll up to.
    const rows = blockRows(address, index);
    if (rows.length === 0) return { absent: true, queried };
    const row = rows[0]!;
    const instances = stateInstanceObservations(address, rows);
    return {
      present: {
        ...(instances.length > 0 ? { instances } : {}),
        type: entity.type,
        physicalId: rows.length === 1 ? (row.id ?? address) : address,
        status: row.mode ?? "managed",
        ownership: "owned",
        attributes: {
          address,
          root,
          ...(row.type ? { resourceType: row.type } : {}),
          ...(row.mode ? { mode: row.mode } : {}),
          ...(row.providerName ? { provider: row.providerName } : {}),
          ...(rows.length > 1 ? { instances: rows.map((r) => r.address).sort() } : {}),
          ...(extra ? extra(address) : {}),
        },
      },
      queried,
    };
  }

  if (entity.type === MODULE_TYPE) {
    if (!moduleIsLive(address, index)) return { absent: true, queried };
    // The state has resources under this module but no row for the block
    // itself, so state membership, which is the whole ownership channel
    // here, has nothing to say about it. See the module doc.
    return {
      present: {
        type: entity.type,
        physicalId: address,
        status: "module",
        ownership: classifyStateOwnership(address, index),
        attributes: { address, root },
      },
      queried,
    };
  }

  return {
    unobserved: {
      reason: "unsupported-kind",
      detail: `${entity.type} has no row in terraform state: only resource and data blocks do`,
    },
    queried,
  };
}

/* ───────────────────────────── the plan depth (#4358) ───────────────────────────── */

/** Which read answered a plan-depth root. */
export type PlanDepthAnswer = "plan" | "state" | "declared";

/** What a plan-depth root's bind produced: the plan, or the state read it fell back to. */
type PlanDepthIndex = { kind: "plan"; plan: PlanIndex; state: StateIndex } | { kind: "state"; state: StateIndex };

/** Does this text name a credentials or authorization failure? Exported for the fallback tests. */
export function planFailureIsCredentials(text: string): boolean {
  return readsAsCredentials(text) || /no valid credential sources|could not find default credentials|failed to refresh cached credentials|NoCredentialProviders|AADSTS|InvalidAccessKeyId|token has expired/i.test(text);
}

/**
 * One plan-depth root's reader. `bind` is the fallback ladder:
 *
 *  1. An uninitialised root (or one that needs `init` again) is refused with
 *     the line to run, and nothing else is read: the state read would need
 *     `init` too, and chant never runs it on a read. Declared only.
 *  2. The plan read answers: `"plan"`.
 *  3. The plan read failed reaching the backend: the state read needs the
 *     same backend, so declared only.
 *  4. The plan read failed any other way, missing provider credentials
 *     first among them: `terraform show -json` over state, with no `init`
 *     (the root is initialised, step 1 checked). `"state"`.
 *  5. That failed too: declared only.
 *
 * `answered` is filled as the ladder runs, for the caller's `sources` and
 * notes.
 */
function planAdapter(
  root: string,
  cwd: string | undefined,
  deps: TerraformReadDeps,
  outcome: { answered: PlanDepthAnswer; note: string; read?: RootRead },
): ObserverAdapter<PlanDepthIndex> {
  const where = cwd ? { cwd } : {};
  const planRead = deps.planRead ?? terraformPlanRead;
  let dir: string | undefined;
  let refusal: { reason: UnobservedReason; detail: string } | undefined;
  const firstLine = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split("\n")[0]!;

  return {
    async bind(): Promise<PlanDepthIndex> {
      outcome.answered = "declared";
      let planErr: unknown;
      try {
        const read = await planRead({ root, ...where });
        dir = read.dir;
        const plan = indexPlan(read.json);
        outcome.answered = "plan";
        outcome.read = { depth: "plan" };
        outcome.note = `terraform.roots.${root}: the plan read answered (\`${read.command.replace(read.planDir, "<tmp>")}\`)`;
        return { kind: "plan", plan, state: indexStateResources({ values: asRecord(plan.priorState).values }) };
      } catch (err) {
        planErr = err;
        if (err instanceof TerraformPlanReadError) dir = err.dir;
      }

      const kind = planErr instanceof TerraformPlanReadError ? planErr.kind : "plan";
      if (kind === "not-initialised" || kind === "backend") {
        refusal = {
          reason: kind === "backend" && planFailureIsCredentials(String((planErr as Error).message)) ? "no-credentials" : kind === "backend" ? "read-failed" : "no-binding",
          detail: `terraform.roots.${root}${dir ? ` (${dir})` : ""}: declared only. ${firstLine(planErr)}${kind === "backend" ? " The state read needs the same backend, so it was not tried." : ""}`,
        };
        outcome.read = { depth: "plan", fellBackTo: "declared", reason: kind === "backend" ? "backend-unreachable" : "needs-init" };
        outcome.note = `terraform.roots.${root}: no read answered, declared only (${kind === "backend" ? "the plan read could not reach the backend" : "the root needs init, which chant never runs"})`;
        throw planErr;
      }

      const why = planFailureIsCredentials(String((planErr as Error)?.message ?? planErr)) ? "no provider credentials" : "the plan failed";
      try {
        const shown = await deps.show({ root, ...where });
        dir = shown.dir;
        outcome.answered = "state";
        outcome.read = { depth: "plan", fellBackTo: "state", reason: why === "no provider credentials" ? "no-credentials" : "plan-failed" };
        outcome.note = `terraform.roots.${root}: the plan read failed (${why}: ${firstLine(planErr)}), so the state read answered; plan attributes are absent`;
        return { kind: "state", state: indexStateResources(shown.json) };
      } catch (err) {
        refusal = {
          reason: "read-failed",
          detail: `terraform.roots.${root}${dir ? ` (${dir})` : ""}: declared only. The plan read failed (${firstLine(planErr)}) and the state read after it failed too (${firstLine(err)})`,
        };
        outcome.read = { depth: "plan", fellBackTo: "declared", reason: "state-read-failed" };
        outcome.note = `terraform.roots.${root}: no read answered, declared only (the plan read failed, ${why}, and the state read failed after it)`;
        throw err;
      }
    },

    classifyBindFailure(err) {
      return refusal ?? { reason: "read-failed", detail: `terraform.roots.${root}${dir ? ` (${dir})` : ""}: ${firstLine(err)}` };
    },

    async read(index, entity): Promise<EntityObservation> {
      const { address } = entity as TerraformDeclared;
      if (index.kind === "state") {
        return readStateEntity(index.state, entity, root, `terraform show -json (root "${root}", address "${address}", after the plan read failed)`);
      }
      const plan = index.plan;
      const seen = readStateEntity(
        index.state,
        entity,
        root,
        `terraform plan -lock=false + show -json <planfile> (root "${root}", address "${address}")`,
        (a) => planAttributesFor(a, plan),
      );
      // A planned create (#4372): no row in `prior_state`, so absent, which is
      // what makes `lifecycle plan` propose the create. The plan still says
      // what it will do and which values stay unknown until apply, so those
      // ride as annotations, which never make the block present.
      if ("absent" in seen && (entity.type === RESOURCE_TYPE || entity.type === DATA_TYPE)) {
        const planned = plannedAttributesFor(address, plan);
        if (planned) return { ...seen, annotations: planned };
      }
      return seen;
    },
  };
}

/** What a live root's plan-depth bind produced: `live-plan`'s index, and the plan when it answered. */
type LivePlanDepthIndex = { live: LivePlanIndex; plan?: PlanIndex };

/** Which reads answered a live root at the plan depth (#4371). */
export type LivePlanDepthAnswer = "live+plan" | "live";

/**
 * One live root's reader at the plan depth (#4371): {@link liveAdapter}'s
 * read, unchanged, with the plan's attributes added to every block it bound.
 * See "On a live root" in the module doc.
 */
function livePlanDepthAdapter(
  root: string,
  cwd: string | undefined,
  deps: TerraformReadDeps,
  outcome: { answered: LivePlanDepthAnswer; note: string; read?: RootRead },
): ObserverAdapter<LivePlanDepthIndex> {
  const where = cwd ? { cwd } : {};
  const live = liveAdapter(root, cwd, deps);
  const planRead = deps.planRead ?? terraformPlanRead;
  const firstLine = (err: unknown): string => (err instanceof Error ? err.message : String(err)).split("\n")[0]!;
  let command = "";

  return {
    async bind(): Promise<LivePlanDepthIndex> {
      outcome.answered = "live";
      outcome.note = `terraform.roots.${root}: no read answered (\`live-plan -json\` failed, so the plan read was not tried)`;
      const index = await live.bind();
      try {
        const read = await planRead({ root, ...where });
        command = read.command.replace(read.planDir, "<tmp>");
        outcome.answered = "live+plan";
        outcome.read = { depth: "live+plan" };
        outcome.note = `terraform.roots.${root}: the plan read answered (\`${command}\`), beside \`live-plan -json\`, which answered presence and ownership`;
        return { live: index, plan: indexPlan(read.json) };
      } catch (err) {
        const kind = err instanceof TerraformPlanReadError ? err.kind : "plan";
        const why =
          kind === "not-initialised"
            ? "the root needs init, which chant never runs"
            : planFailureIsCredentials(String(err instanceof Error ? err.message : err))
              ? "no provider credentials"
              : kind === "backend"
                ? "the plan read could not reach the backend"
                : "the plan failed";
        outcome.read = {
          depth: "live+plan",
          fellBackTo: "live",
          reason: kind === "not-initialised" ? "needs-init" : kind === "backend" ? "backend-unreachable" : why === "no provider credentials" ? "no-credentials" : "plan-failed",
        };
        outcome.note = `terraform.roots.${root}: the plan read failed (${why}: ${firstLine(err)}), so \`live-plan -json\` alone answered; plan attributes are absent`;
        return { live: index };
      }
    },

    classifyBindFailure(err) {
      return live.classifyBindFailure!(err);
    },

    async read(index, entity): Promise<EntityObservation> {
      const observed = await live.read(index.live, entity);
      const { plan } = index;
      if (!plan) return observed;
      const queried = `${observed.queried}; ${command} + show -json <planfile>`;
      const present = "present" in observed ? observed.present : undefined;
      if (!present || entity.type !== RESOURCE_TYPE || present.ownership !== "owned") return { ...observed, queried };
      const { address } = entity as TerraformDeclared;
      return {
        ...observed,
        present: { ...present, attributes: { ...present.attributes, ...planAttributesFor(address, plan) } },
        queried,
      };
    },
  };
}

/** The environment variable that overrides every root's observation depth for one run (#4358). */
export const TERRAFORM_OBSERVE_ENV = "CHANT_TERRAFORM_OBSERVE";

/**
 * Each root's observation depth, in precedence order: the caller's `depth`,
 * then {@link TERRAFORM_OBSERVE_ENV}, then the root's own `observe`, then the
 * namespace's, then `"state"`. The config is read only when neither of the
 * first two settles it, and a config that cannot be read means `"state"`,
 * which is what every root read before the plan depth existed.
 */
async function observeDepths(
  options: Pick<DescribeResourcesOptions, "depth" | "cwd">,
  notes: string[],
): Promise<(root: string) => TerraformObserveDepth> {
  if (options.depth) return () => options.depth!;
  const env = process.env[TERRAFORM_OBSERVE_ENV];
  if (env === "plan" || env === "state") return () => env;
  if (env) notes.push(`${TERRAFORM_OBSERVE_ENV}=${JSON.stringify(env)} is neither "state" nor "plan" and was ignored`);
  try {
    const { loadChantConfigUpward } = await import("@intentius/chant/config");
    const { resolve } = await import("node:path");
    const { config } = await loadChantConfigUpward(resolve(options.cwd ?? process.cwd()));
    const namespace = (config as { terraform?: { observe?: TerraformObserveDepth; roots?: Record<string, { observe?: TerraformObserveDepth }> } }).terraform;
    return (root) => namespace?.roots?.[root]?.observe ?? namespace?.observe ?? "state";
  } catch {
    return () => "state";
  }
}

export interface DescribeResourcesOptions {
  environment: string;
  buildOutput: string;
  entityNames: string[];
  entities: Map<string, { entityType: string; props: Record<string, unknown> }>;
  /**
   * Restrict to state-backed entities (#1348). A withheld entity is
   * `filtered`, never a silent drop into `absent`: a live module block still
   * exists, chant just has no state row saying it is managed.
   */
  owned?: boolean;
  /**
   * Directory the activities start the `chant.config.*` search from. Default:
   * the running process's cwd. Same meaning as `TerraformWatchOpConfig.cwd`.
   */
  cwd?: string;
  /**
   * Read every stock root at this depth (#4358), over the config's
   * `terraform.observe` and `terraform.roots.<name>.observe` and the
   * `CHANT_TERRAFORM_OBSERVE` variable. Not a core option: a caller holding
   * this lexicon directly (behold) passes it, and the CLI reaches it through
   * the config or the variable.
   */
  depth?: TerraformObserveDepth;
}

/**
 * Observe every declared terraform entity, one `init` + `show` per configured
 * root. Roots are read independently, so a broken backend on one never
 * un-observes another (`mergeObservations`).
 */
export async function describeResources(
  options: DescribeResourcesOptions,
  deps: TerraformReadDeps = REAL_DEPS,
): Promise<DescribeResourcesResult> {
  const byRoot = new Map<string, TerraformDeclared[]>();
  const rootless: TerraformDeclared[] = [];

  for (const name of options.entityNames) {
    const declared = declaredOf(name, options.entities.get(name));
    if (!declared.root) {
      rootless.push(declared);
      continue;
    }
    const bucket = byRoot.get(declared.root);
    if (bucket) bucket.push(declared);
    else byRoot.set(declared.root, [declared]);
  }

  const parts = [];
  const notes: string[] = [];
  // Which of the two reads answered, per entity (#2267). Filled for every
  // entity of the root before the read runs, so the answer is on the wire
  // whatever the verdict came back as: present, absent, or not-observed. A
  // renderer joins observations to nodes, and painting `terraform show -json`
  // over state the same green as a live read of the account is the drift lie
  // an overlay exists to prevent.
  const sources: Record<string, string> = {};
  const rootReads: Record<string, RootRead> = {};
  const depthOf = byRoot.size > 0 ? await observeDepths(options, notes) : () => "state" as const;
  for (const [root, declared] of byRoot) {
    // One fact decides the whole read, and the parse already recorded it on
    // every entity of the root (#2103). A root is live when its binary is
    // choudoufu AND it declares an estate, so a single entity carrying
    // `mode: "live"` settles it for the root.
    const live = declared.some((entity) => entity.mode === "live");
    const depth = depthOf(root);
    if (live) {
      notes.push(
        `terraform.roots.${root} is a live root: ownership came from choudoufu's tofu-estate/tofu-address markers via \`live-plan -json\`, not from a state file`,
      );
      if (depth === "plan") {
        // Both reads (#4371): `live-plan` for ownership, the plan for the
        // attributes on what it bound. `sources` is known only after the read.
        const outcome: { answered: LivePlanDepthAnswer; note: string; read?: RootRead } = { answered: "live", note: "" };
        const read = await observeEntities(declared, livePlanDepthAdapter(root, options.cwd, deps, outcome));
        for (const entity of declared) sources[entity.name] = outcome.answered;
        if (outcome.read) rootReads[`terraform.roots.${root}`] = outcome.read;
        if (outcome.note) notes.push(outcome.note);
        parts.push(normalizeObservation(read));
        continue;
      }
      for (const entity of declared) sources[entity.name] = "live";
      parts.push(normalizeObservation(await observeEntities(declared, liveAdapter(root, options.cwd, deps))));
      continue;
    }
    if (depth === "plan") {
      // The third depth (#4358). `sources` says which read answered, which on
      // a plan-depth root is only known after the read: the plan, the state
      // read it fell back to, or neither, in which case it names the read
      // that was attempted last.
      const outcome: { answered: PlanDepthAnswer; note: string; read?: RootRead } = { answered: "declared", note: "" };
      const read = await observeEntities(declared, planAdapter(root, options.cwd, deps, outcome));
      const value = outcome.answered === "state" ? "state" : "plan";
      for (const entity of declared) sources[entity.name] = value;
      if (outcome.read) rootReads[`terraform.roots.${root}`] = outcome.read;
      if (outcome.note) notes.push(outcome.note);
      parts.push(normalizeObservation(read));
      continue;
    }
    for (const entity of declared) sources[entity.name] = "state";
    parts.push(normalizeObservation(await observeEntities(declared, adapter(root, options.cwd, deps))));
  }

  const merged = mergeObservations(parts);
  merged.notes.push(...notes);
  const resources = { ...merged.resources };
  const unobserved = { ...merged.unobserved };

  // An entity carrying no root came from somewhere other than `buildRoots()`;
  // there is no state file to look it up in, and saying so is not absence.
  for (const entity of rootless) {
    unobserved[entity.name] = {
      ...(entity.type ? { type: entity.type } : {}),
      reason: "unsupported-kind",
      detail: "no `terraform.roots` entry on this entity, so there is no root module state to read it from",
    };
  }

  if (options.owned) {
    for (const [name, meta] of Object.entries(merged.resources)) {
      if (meta.ownership === "owned") continue;
      delete resources[name];
      unobserved[name] = {
        type: meta.type,
        reason: "filtered",
        detail: `this address read \`${meta.ownership ?? "unknown"}\` on the root's ownership channel (its state file, or its live markers) and --owned was requested`,
        ...(merged.queried[name] ? { queried: merged.queried[name] } : {}),
      };
    }
  }

  // A planned create's plan attributes (#4372) ride beside the verdict, never
  // in `resources`: the block stays absent.
  return observation(resources, unobserved, merged.queried, merged.notes, undefined, sources, merged.annotations, rootReads);
}
