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
  type UnobservedReason,
} from "@intentius/chant/observation";
import type { OwnershipMarker } from "@intentius/chant/ownership";
import {
  choudoufuLiveLs,
  choudoufuLivePlan,
  terraformInit,
  terraformShow,
} from "./op/activities/terraform";
import { DATA_TYPE, MODULE_TYPE, RESOURCE_TYPE } from "./hcl/parse";

// The channel keys live in their own module so `plugin.ts` can declare
// `ownershipChannel` without loading this reader. Re-exported here because
// this is where they are used.
export { TERRAFORM_STATE_OWNERSHIP_KEYS } from "./state-ownership";
export { TERRAFORM_LIVE_MARKER_KEYS } from "./live-ownership";

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

/** True when the state carries at least one resource beneath `module.<name>`. */
function moduleIsLive(address: string, index: StateIndex): boolean {
  if (index.modules.has(address)) return true;
  for (const key of index.rows.keys()) if (key.startsWith(`${address}.`)) return true;
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

/** A `live-plan -json` document, indexed by declared instance address. */
export interface LivePlanIndex {
  /** `estate`: the estate every section was computed against. */
  estate: string;
  bound: Map<string, LivePlanBoundRow>;
  omissions: Map<string, LivePlanOmissionRow>;
  unowned: Map<string, LivePlanUnownedRow>;
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

  for (const entry of asArray(doc.diagnostics)) {
    const row = asRecord(entry);
    const summary = asString(row.summary);
    if (summary) index.diagnostics.push(`${asString(row.severity) ?? "warning"}: ${summary}`);
  }

  index.addresses = [
    ...new Set([...index.bound.keys(), ...index.omissions.keys(), ...index.unowned.keys()]),
  ].sort();
  return index;
}

/**
 * choudoufu's omission reason codes, mapped onto chant's total vocabulary
 * (`internal/live/projection/result.go`). `"absent"` is not an
 * {@link UnobservedReason}: it is the tri-state's OBSERVED-ABSENT, the one
 * omission that is a claim of knowledge rather than of ignorance.
 *
 * A code this table does not know maps to `read-failed`, which is the safe
 * direction: no NOT-OBSERVED verdict ever becomes a create or a delete.
 */
export const LIVE_PLAN_OMISSION_REASONS: Readonly<Record<string, UnobservedReason | "absent">> = {
  // The provider was asked and reported, normally, that nothing is there.
  ABSENT: "absent",
  // The provider errored, or could not be reached in a usable order.
  FAILED: "read-failed",
  PARENT_UNAVAILABLE: "read-failed",
  CYCLE: "read-failed",
  INCOMPLETE_BLOCK: "read-failed",
  LISTED_NOT_IMPORTABLE: "read-failed",
  // Something exists at the identity and does not carry this estate's marker.
  // Normally answered by the `unowned[]` section before this table is read;
  // this entry is what happens if a document ever carries the omission alone.
  UNOWNED: "read-failed",
  // The mode cannot name, list or tag this instance at all: a server-assigned
  // identity with no marker to find it by, a resource with no cloud object to
  // read, or an address another declared instance has taken over.
  NEEDS_DISCOVERY: "unsupported-kind",
  UNREADABLE: "unsupported-kind",
  SUPERSEDED: "unsupported-kind",
};

/** Does this text name a credentials or authorization failure rather than any other error? */
function readsAsCredentials(text: string): boolean {
  return /\b(no valid credential|credentials?|not authorized|unauthorized|accessdenied|access denied|expiredtoken|invalidclienttokenid|signature)\b/i.test(
    text,
  );
}

/** The chant verdict for one omission: `no-credentials` when its detail says so. */
function omissionVerdict(row: LivePlanOmissionRow): UnobservedReason | "absent" {
  const mapped = LIVE_PLAN_OMISSION_REASONS[row.reason] ?? "read-failed";
  if (mapped === "read-failed" && readsAsCredentials(row.detail)) return "no-credentials";
  return mapped;
}

/** Every instance address in the document belonging to the declared block `address`. */
function instancesOf(address: string, index: LivePlanIndex): string[] {
  return index.addresses.filter((a) => a === address || a.startsWith(`${address}[`));
}

/** True when the document names any instance under `module.<name>`, at any depth. */
function liveModuleMembers(address: string, index: LivePlanIndex): string[] {
  return index.addresses.filter(
    (a) => a === address || a.startsWith(`${address}.`) || a.startsWith(`${address}[`),
  );
}

/** One instance's verdict, before a block aggregates its instances. */
type InstanceVerdict =
  | { kind: "owned"; row: LivePlanBoundRow }
  | { kind: "adoptable"; row: LivePlanUnownedRow }
  | { kind: "foreign"; row: LivePlanUnownedRow }
  | { kind: "absent" }
  | { kind: "unobserved"; reason: UnobservedReason; detail: string };

/**
 * Classify one instance address against the document, `unowned[]` first: a
 * declared instance that also carries a `UNOWNED` omission is answered by the
 * section that has the verdict, not by the one that has the apology.
 */
function classifyLiveInstance(address: string, index: LivePlanIndex): InstanceVerdict {
  const unowned = index.unowned.get(address);
  if (unowned) {
    return unowned.adoptEstate || unowned.adoptAddress
      ? { kind: "adoptable", row: unowned }
      : { kind: "foreign", row: unowned };
  }

  const bound = index.bound.get(address);
  if (bound) return { kind: "owned", row: bound };

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
  if (instances.length > 1 || instances[0] !== address) attributes.instances = instances;

  const unobserved = verdicts.find((v) => v.kind === "unobserved");
  if (unobserved && unobserved.kind === "unobserved") {
    return { unobserved: { reason: unobserved.reason, detail: unobserved.detail }, queried };
  }

  const foreign = verdicts.find((v) => v.kind === "foreign");
  if (foreign && foreign.kind === "foreign") {
    return {
      present: {
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

  const adoptable = verdicts.find((v) => v.kind === "adoptable");
  if (adoptable && adoptable.kind === "adoptable") {
    // `unknown`, not `foreign`: the resource matches the declaration and one
    // tag write claims it. The two values that write carries are the whole
    // adoption proposal #2105 builds its Op on, so they ride the metadata
    // rather than being re-derived from the address there. No `marker` is
    // surfaced, because nothing was read off this resource: it carries none.
    return {
      present: {
        type: entity.type,
        physicalId: adoptable.row.identity ?? address,
        status: "adoptable",
        ownership: "unknown",
        attributes: {
          ...attributes,
          ...(adoptable.row.type ? { resourceType: adoptable.row.type } : {}),
          ...(adoptable.row.adoptEstate ? { adoptTofuEstate: adoptable.row.adoptEstate } : {}),
          ...(adoptable.row.adoptAddress ? { adoptTofuAddress: adoptable.row.adoptAddress } : {}),
        },
      },
      queried,
    };
  }

  const owned = verdicts.filter((v) => v.kind === "owned") as Array<{ kind: "owned"; row: LivePlanBoundRow }>;
  if (owned.length === 0) return { absent: true, queried };

  const sources = [...new Set(owned.map((v) => v.row.source ?? "unknown"))].sort();
  const byMarker = sources.length === 1 && sources[0] === "marker";
  return {
    present: {
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

/** The entity key `buildRoots()` would have produced for a live resource's address. */
function entityKeyFor(root: string, address: string): string {
  return `${root}/${address}`;
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
 * Every live root the project declares, in config order. Reads the project
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
  const namespace = (config as { terraform?: { binary?: string; roots?: Record<string, { dir: string }> } })
    .terraform;
  if (namespace?.binary !== "choudoufu") return [];

  const live: Array<{ root: string; estate: string }> = [];
  for (const [name, root] of Object.entries(namespace.roots ?? {})) {
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
  livePlan: typeof choudoufuLivePlan;
  liveLs: typeof choudoufuLiveLs;
}

const REAL_DEPS: TerraformReadDeps = {
  init: terraformInit,
  show: terraformShow,
  livePlan: choudoufuLivePlan,
  liveLs: choudoufuLiveLs,
};

/** A declared entity, plus the root, address and mode `buildRoots()` recorded on it. */
interface TerraformDeclared extends DeclaredEntity {
  root: string;
  address: string;
  /** `"live"` when the root runs under choudoufu with a declared estate (#2103). */
  mode?: string;
}

/**
 * Split a `<root>/<address>` entity key. Only a fallback: `buildRoots()`
 * records both on `props`, and a duplicated address is keyed `…~2` there, so
 * the props are the reliable source.
 */
function fromEntityName(name: string): { root: string; address: string } {
  const slash = name.indexOf("/");
  if (slash === -1) return { root: "", address: name };
  return { root: name.slice(0, slash), address: name.slice(slash + 1).replace(/~\d+$/, "") };
}

function declaredOf(name: string, entity: { entityType: string; props: Record<string, unknown> } | undefined): TerraformDeclared {
  const props = entity?.props ?? {};
  const fallback = fromEntityName(name);
  return {
    name,
    type: entity?.entityType ?? "",
    props,
    root: asString(props.root) ?? fallback.root,
    address: asString(props.address) ?? fallback.address,
    ...(asString(props.mode) ? { mode: asString(props.mode) } : {}),
  };
}

/** One root's reader: `init`, then `show` over state, then address matching. */
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
      const { address } = entity as TerraformDeclared;
      const queried = `terraform show -json (root "${root}", address "${address}")`;

      if (entity.type === RESOURCE_TYPE || entity.type === DATA_TYPE) {
        const row = index.rows.get(address);
        if (!row) return { absent: true, queried };
        return {
          present: {
            type: entity.type,
            physicalId: row.id ?? address,
            status: row.mode ?? "managed",
            ownership: classifyStateOwnership(address, index),
            attributes: {
              address,
              root,
              ...(row.type ? { resourceType: row.type } : {}),
              ...(row.mode ? { mode: row.mode } : {}),
              ...(row.providerName ? { provider: row.providerName } : {}),
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
    },
  };
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
  for (const [root, declared] of byRoot) {
    // One fact decides the whole read, and the parse already recorded it on
    // every entity of the root (#2103). A root is live when its binary is
    // choudoufu AND it declares an estate, so a single entity carrying
    // `mode: "live"` settles it for the root.
    const live = declared.some((entity) => entity.mode === "live");
    if (live) {
      notes.push(
        `terraform.roots.${root} is a live root: ownership came from choudoufu's tofu-estate/tofu-address markers via \`live-plan -json\`, not from a state file`,
      );
    }
    const read = live
      ? await observeEntities(declared, liveAdapter(root, options.cwd, deps))
      : await observeEntities(declared, adapter(root, options.cwd, deps));
    parts.push(normalizeObservation(read));
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

  return observation(resources, unobserved, merged.queried, merged.notes);
}
