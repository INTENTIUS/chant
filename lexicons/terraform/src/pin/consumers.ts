/**
 * Where a repo calls its modules (chant#4599, terragucci#1289 bundle B): one
 * entry per module call in the roots given, Terragrunt units included, read
 * from the source files with chant's HCL parse and never from a plan, so the
 * scan runs in a check job before anything is planned.
 *
 * Each call carries its root, file and block path, the source as written,
 * the module it names with the pin taken out and normalised
 * ({@link normalizeModuleSource}), and the pin `readModulePin` (./source.ts)
 * reads. A local call (`./`, `../`) names no published module and is left
 * out. The release catalog lists these as a version's consumers, and
 * `deprecatedPins` (../registry/deprecated.ts) checks them against it.
 *
 * The `terragucci_module_pin` metric keeps reading the plan; this is the
 * source-side view of the same calls. The normal form is chant#3924's
 * (../registry/source-forms.ts), shared with `usedSources` (../sources.ts).
 */
import { join, relative } from "node:path";
import type { Hcl2Json } from "@intentius/chant/terraform/hcl2json";
import { MODULE_TYPE, TERRAGRUNT_SOURCE_TYPE, parseTerraformRootDir, type TerraformEntity } from "../hcl/parse";
import { normalizeModuleSource, PUBLIC_REGISTRY_HOST } from "../registry/source-forms";
import { readModulePin, type ModuleCallPin } from "./source";

export { normalizeModuleSource, PUBLIC_REGISTRY_HOST };

/** One module call in a consuming repo. */
export interface ModuleConsumer {
  /** The root (or Terragrunt unit) directory, from the repo's top, `/`-separated. */
  root: string;
  /** The file holding the call, from the repo's top. */
  file: string;
  /** The block: `module.<name>`, or `terragrunt.terraform` for a unit's source. */
  address: string;
  /** `terraform` for a module block, `terragrunt` for a unit's `terraform { source }`. */
  kind: "terraform" | "terragrunt";
  /** The `source` as written. */
  source: string;
  /** The module the call names: the source with the pin taken out, normalised. */
  module: string;
  /** The pinned version, tag, digest or ref, or null when the call pins none. */
  pin: string | null;
  /** Where the pin is, as `readModulePin` reads it. */
  at: ModuleCallPin["at"];
  param?: ModuleCallPin["param"];
  /** Why there is no pin, when `pin` is null. */
  unpinned?: string;
}

/** A source names a local directory, not a published module. */
export function isLocalSource(source: string): boolean {
  return source.startsWith("./") || source.startsWith("../");
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * Every module call in `roots` (directories from `repo`), sorted by root,
 * file and address. A root whose files cannot be parsed throws, naming the
 * root, so a check job fails loudly instead of listing fewer consumers.
 */
export async function moduleConsumers(repo: string, roots: readonly string[], parser?: Hcl2Json): Promise<ModuleConsumer[]> {
  const out: ModuleConsumer[] = [];
  for (const root of [...new Set(roots)].sort()) {
    const dir = join(repo, root);
    const rel = relative(repo, dir).split("\\").join("/") || ".";
    let entities: TerraformEntity[];
    try {
      entities = [...(await parseTerraformRootDir(dir, "consumers", parser)).values()] as TerraformEntity[];
    } catch (e) {
      throw new Error(`${rel}: ${(e as Error).message}`);
    }
    for (const e of entities) {
      if (e.entityType !== MODULE_TYPE && e.entityType !== TERRAGRUNT_SOURCE_TYPE) continue;
      const source = str(e.props.body.source);
      if (source === undefined || isLocalSource(source)) continue;
      const version = e.entityType === MODULE_TYPE ? str(e.props.body.version) : undefined;
      const pin = readModulePin(source, version);
      out.push({
        root: rel,
        file: rel === "." ? e.props.file : `${rel}/${e.props.file}`,
        address: e.props.address,
        kind: e.entityType === MODULE_TYPE ? "terraform" : "terragrunt",
        source,
        module: normalizeModuleSource(pin.module),
        pin: pin.pin,
        at: pin.at,
        ...(pin.param ? { param: pin.param } : {}),
        ...(pin.unpinned ? { unpinned: pin.unpinned } : {}),
      });
    }
  }
  return out.sort((a, b) => a.root.localeCompare(b.root) || a.file.localeCompare(b.file) || a.address.localeCompare(b.address));
}
