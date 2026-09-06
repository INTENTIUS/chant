/**
 * The `allowed_*_ids` allowlists, and the one translation both halves of the
 * round trip read (#2166, #2176).
 *
 * fountain types `allowed_vault_ids` and `allowed_environment_ids` as
 * `{:array, :binary_id}` and resolves no name inside either, while the
 * manifest's reference form is the resource's name (FTN021's rule) — the
 * `Steward` composite writes the `Vault` declaration itself into
 * `allowed_vault_ids`, and a hand-written manifest writes the vault's name.
 * So the applier turns names into ids on the way out (#2166) and the deep
 * reader turns ids back into the declaration's own vocabulary on the way in
 * (#2176). Two directions over one rule about which entries are ids and which
 * are references, kept in one module so the two cannot come apart again.
 *
 * A module of its own rather than a section of ./live-identity.ts, which is
 * where the rest of this lexicon's identity rules live: live-identity.ts
 * already imports the applier for `isChantOwned` and `FountainHttp`, so the
 * applier importing the rule back out of it would make the two files import
 * each other. This module imports nothing, so both halves can depend on it.
 *
 * Both directions are element-wise and leave the three states of the field
 * alone: an absent list stays absent, an empty list stays empty (`[]` means no
 * vault may attach, which is a posture somebody chose), and a populated list
 * keeps its length. Neither direction ever drops an entry — an id nothing
 * answers to passes through as itself, so a vault deleted out of band surfaces
 * in the diff instead of disappearing from it.
 */

/** A fountain uuid, which is what both allowlist columns are typed as on the wire. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The allowlist fields whose entries are ids on the wire and references in source. */
export const ALLOWLIST_FIELDS = ["allowed_vault_ids", "allowed_environment_ids"] as const;

export type AllowlistField = (typeof ALLOWLIST_FIELDS)[number];

/**
 * One allowlist's entries, or `undefined` when the tree does not carry that
 * field as a list. `undefined` and `[]` are different states and both callers
 * have to keep them apart, so neither is collapsed here.
 */
export function allowlistOf(
  tree: Record<string, unknown>,
  field: AllowlistField,
): unknown[] | undefined {
  const value = tree[field];
  return Array.isArray(value) ? value : undefined;
}

/**
 * The `allowed_vault_ids` entries that are vault names rather than uuids (#2166).
 *
 * The composites author that field as a reference to the Vault declaration,
 * and the manifest's reference form is the resource's name (FTN021). Fountain
 * resolves a sibling `environment:` name but not these, so anything here has
 * to be resolved before the spec is sent. Pure.
 */
export function vaultNameRefs(spec: Record<string, unknown>): string[] {
  return (allowlistOf(spec, "allowed_vault_ids") ?? []).filter(
    (v): v is string => typeof v === "string" && !UUID_RE.test(v),
  );
}

/**
 * The write direction: every name in an allowlist replaced by the id `idOf`
 * answers with. A uuid is already the wire vocabulary and is left alone, so a
 * hand-written manifest that carries ids keeps working. `idOf` decides what a
 * name nothing answers to means — the applier throws there, naming the agent
 * and the name.
 */
export async function allowlistToIds(
  entries: readonly unknown[],
  idOf: (name: string) => Promise<string>,
): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string" || UUID_RE.test(entry)) out.push(entry);
    else out.push(await idOf(entry));
  }
  return out;
}

/**
 * The declared entries of an allowlist indexed by the fountain name each one
 * points at, so the read direction can find the form source wrote for a vault
 * without caring whether that form was a name or a declaration.
 *
 * `nameOfRef` is `referencedName` bound to the reader's name index: a string
 * is its own answer (a declared uuid lands under the uuid), and a `Vault` or
 * `Environment` declaration lands under the name it reconciles by. First entry
 * wins, which only matters for a list that names the same vault twice.
 */
export function declaredAllowlistRefs(
  entries: readonly unknown[] | undefined,
  nameOfRef: (value: unknown) => string | undefined,
): Map<string, unknown> {
  const byName = new Map<string, unknown>();
  for (const entry of entries ?? []) {
    const name = nameOfRef(entry);
    if (name !== undefined && !byName.has(name)) byName.set(name, entry);
  }
  return byName;
}

/**
 * The read direction: a live allowlist rendered in the vocabulary the
 * declaration used.
 *
 * Per entry, in order:
 *
 * - The declaration carries this uuid verbatim, so the id IS the declared
 *   vocabulary and translating it would manufacture drift. Same guard the
 *   scalar reference translation applies to `environment_id`.
 * - The uuid resolves to a resource the declaration references — by name, or
 *   by the declaration itself, which is what `Steward` writes. The entry
 *   source wrote is what comes back, so both trees flatten to the same keyed
 *   path and a vault chant scoped does not read as held by somebody else.
 * - The uuid resolves to a resource nothing in this declaration references.
 *   Its name comes back: an allowlist widened by hand is a finding, and it
 *   should be readable.
 * - Nothing answers to the uuid, because the vault was deleted out of band.
 *   The raw id comes back, which is the honest thing to report and reaches the
 *   diff as a difference rather than being dropped.
 */
export function allowlistToDeclared(
  entries: readonly unknown[],
  nameOf: (id: string) => string | undefined,
  declaredRefs: ReadonlyMap<string, unknown>,
): unknown[] {
  return entries.map((entry) => {
    if (typeof entry !== "string") return entry;
    if (declaredRefs.has(entry)) return declaredRefs.get(entry);
    if (!UUID_RE.test(entry)) return entry;
    const name = nameOf(entry);
    if (name === undefined) return entry;
    return declaredRefs.has(name) ? declaredRefs.get(name) : name;
  });
}
