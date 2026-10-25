/**
 * Addresses in a composed root (chant#4442): each member a top-level
 * `module.<m>` call, so a member's addresses are the composed root's with
 * `module.<m>.` taken off. `chant terraform report` (../report.ts) and the
 * composed run's slicer (./slice.ts) and state split (./state-merge.ts) all
 * strip with these functions, so there is one implementation.
 */

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => v !== null && typeof v === "object" && !Array.isArray(v);

const TOP_MODULE = /^module\.([^.[\]]+)(?:\[(?:"(?:[^"\\]|\\.)*"|\d+)\])?(?:\.|$)/;

/** The top-level module an address or module address is in, or undefined for the composed root's own. */
export function topModule(address: string): string | undefined {
  return TOP_MODULE.exec(address)?.[1];
}

/** `address` with its leading `module.<m>` (and index) taken off. An address in no module is returned as it is. */
export function stripModule(address: string): string {
  const m = TOP_MODULE.exec(address);
  return m ? address.slice(m[0].length) : address;
}

/** Whether `address` is `module.<m>` or inside it. */
export const inModule = (address: string | undefined, m: string): boolean => address !== undefined && topModule(address) === m;

/**
 * A `resource_changes` (or `resource_drift`) entry with its top module taken
 * off `address`, `previous_address` and `module_address`. A module address
 * that was the top module itself is dropped, as a root planned alone has none.
 */
export function stripChange(rc: Json): Json {
  const out: Json = { ...rc, address: stripModule(String(rc.address)) };
  if (typeof rc.previous_address === "string") out.previous_address = stripModule(rc.previous_address);
  if (typeof rc.module_address === "string") {
    const rest = stripModule(rc.module_address);
    if (rest === "" || rest === rc.module_address) delete out.module_address;
    else out.module_address = rest;
  }
  return out;
}

/** The entries of a `resource_changes` list in module `m` (undefined: the composed root's own), each stripped. */
export function moduleChanges(list: unknown, m: string | undefined): Json[] {
  const changes = Array.isArray(list) ? list : [];
  return changes.filter((r): r is Json => isObject(r) && topModule(String(r.module_address ?? r.address ?? "")) === m).map(stripChange);
}
