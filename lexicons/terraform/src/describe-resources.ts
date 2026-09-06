/**
 * Live observation for declared terraform entities (#2087).
 *
 * `buildRoots()` turns each configured root module into one entity per HCL
 * block, keyed `<root>/<address>` (`./hcl/parse.ts`). This reader answers the
 * lifecycle question for those entities by running `terraform show -json` over
 * the root's current state and matching addresses.
 *
 * ## The state file is the ownership answer
 *
 * Every other lexicon in chant stamps a tag or a label at synthesis and reads
 * it back off the live resource. Terraform stamps nothing, and there is
 * nowhere to stamp: a resource's provider-side tags are the practitioner's
 * own, and writing chant's marker into them would edit an estate this lexicon
 * promises never to write. What terraform has instead is the thing chant
 * elsewhere refuses to host — a trusted state file that already records
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
 * That places terraform on the trusted-state-file row of the third axis in
 * docs/src/content/docs/concepts/lifecycle-models.mdx, where chant elsewhere
 * sits on the live-marker row. `docs/pages/observation.mdx` is the reader's
 * version of this paragraph.
 *
 * ## What is readable at all
 *
 * `values.root_module.resources[]` (and, recursively, `child_modules[]`)
 * carries `resource` and `data` blocks. A `terraform`, `provider`, `variable`,
 * `output` or `locals` block has no row there and reads `unsupported-kind` —
 * honest, and not a gap to close by inventing an address for something that
 * has none.
 *
 * ## Tri-state (#1089)
 *
 * A root whose `init` or `show` fails reports EVERY entity declared in that
 * root as not-observed with reason `read-failed` and the root named, never
 * absent — a failed read must never render as a list of creates. Roots are
 * read independently and merged (`mergeObservations`), so one broken backend
 * does not un-observe a root that answered.
 *
 * ## Nothing from `values` is surfaced
 *
 * A state row's `values` are the resource's full attribute set, secrets
 * included, and `sensitive_values` describes only what the configuration
 * declared sensitive. So the attributes reported here are the row's identity
 * (address, type, mode, provider, root) and nothing from `values` except the
 * `id`, which is the physical id every observation carries.
 */

import type { DescribeResourcesResult } from "@intentius/chant/lexicon";
import {
  mergeObservations,
  normalizeObservation,
  observation,
  observeEntities,
  type DeclaredEntity,
  type EntityObservation,
  type ObserverAdapter,
} from "@intentius/chant/observation";
import { terraformInit, terraformShow } from "./op/activities/terraform";
import { DATA_TYPE, MODULE_TYPE, RESOURCE_TYPE } from "./hcl/parse";

// The channel keys live in their own module so `plugin.ts` can declare
// `ownershipChannel` without loading this reader. Re-exported here because
// this is where they are used.
export { TERRAFORM_STATE_OWNERSHIP_KEYS } from "./state-ownership";

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
 * missing it — belt and braces for an older `format_version`, never a second
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

/** The activity pair this reader drives. Injectable so tests never run terraform. */
export interface TerraformReadDeps {
  init: typeof terraformInit;
  show: typeof terraformShow;
}

const REAL_DEPS: TerraformReadDeps = { init: terraformInit, show: terraformShow };

/** A declared entity, plus the root and address `buildRoots()` recorded on it. */
interface TerraformDeclared extends DeclaredEntity {
  root: string;
  address: string;
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
  };
}

/** One root's reader: `init`, then `show` over state, then address matching. */
function adapter(root: string, cwd: string | undefined, deps: TerraformReadDeps): ObserverAdapter<StateIndex> {
  const where = cwd ? { cwd } : {};
  let dir: string | undefined;

  return {
    async bind(): Promise<StateIndex> {
      // `init` first: `show` against an uninitialized root reports no state at
      // all, which would read as "everything is absent" — the exact failure
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
        // itself, so state membership — the whole ownership channel here —
        // has nothing to say about it. See the module doc.
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
          detail: `${entity.type} has no row in terraform state — only resource and data blocks do`,
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
  for (const [root, declared] of byRoot) {
    parts.push(normalizeObservation(await observeEntities(declared, adapter(root, options.cwd, deps))));
  }

  const merged = mergeObservations(parts);
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
        detail: "the root's state carries no row for this address and --owned was requested",
        ...(merged.queried[name] ? { queried: merged.queried[name] } : {}),
      };
    }
  }

  return observation(resources, unobserved, merged.queried, merged.notes);
}
