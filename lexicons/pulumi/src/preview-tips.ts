/**
 * Preview tips from a Pulumi member's change set (#4634). A tip names a
 * pattern in a preview that usually wants a fix before the update: the
 * product holds each tip's words and fix (plywood's `src/tips.ts` and
 * `plywood tips <id>`), and this module finds the pattern in the change set
 * the preview became (`./change-set.ts`). The note shows each tip as a row
 * with its id, through the lexicon's `prNoteDetail`.
 *
 * | id | found when |
 * |---|---|
 * | `rename-without-aliases` | the preview deletes a resource and creates one of the same type whose name has the same stem, or the same name under another parent |
 * | `replace-on-name` | a replace that creates before it deletes, forced by a name input (`name`, `<x>Name`, `bucket`) |
 * | `unknown-in-apply` | an entry the preview could not list (`mayAppear`): something registers inside an `apply()` |
 *
 * A rename with `aliases` is not a delete and a create: Pulumi follows the
 * alias and the preview shows the resource under its new URN as `same` or
 * `update`. So a delete and a create of one type and stem in one preview is
 * the rename without them. The stem is the name up to its first `-`, `_`,
 * `.`, `:` or `/`, lowercased, so `assets` and `assets-v2` pair, and so
 * does `worker-2` with a new `worker-3`; each delete pairs with one create
 * at most.
 *
 * Tips plywood lists that a change set cannot show are left out:
 * `secret-in-plain-config` reads stack config, which no preview step holds,
 * and `no-protect-on-data` reads `protect`, which the change set does not
 * carry.
 */
import type { ChangeSetDocument, ChangeSetEntry } from "@intentius/chant/change-set";

/** The tip ids this module finds, as plywood's tips page names them. */
export const PULUMI_PREVIEW_TIP_IDS = ["rename-without-aliases", "replace-on-name", "unknown-in-apply"] as const;

export type PulumiPreviewTipId = (typeof PULUMI_PREVIEW_TIP_IDS)[number];

/** One tip found in a member's change set. */
export interface PulumiPreviewTip {
  id: PulumiPreviewTipId;
  member: string;
  /** The entry's address (a URN, or a may-appear address). */
  address: string;
  type: string;
  name?: string;
  /** For a rename: the created resource's address and name. */
  created?: { address: string; name?: string };
  /** For a replace: the name inputs that force it. */
  inputs?: string[];
}

/** The stem a rename keeps: the name up to its first separator, lowercased. */
export function nameStem(name: string): string {
  return name.toLowerCase().split(/[-_.:/]/)[0] ?? "";
}

/** A name input: `name`, `<x>Name`, `<x>_name`, or an S3 bucket's `bucket`. */
const NAME_INPUT = /^(name|bucket|[a-z][A-Za-z0-9]*Name|[a-z0-9_]+_name)$/;

/** The tips in `entries`, in order: renames, then replaces, then what may register at up. Only pulumi entries are read. */
export function pulumiPreviewTips(entries: readonly ChangeSetEntry[]): PulumiPreviewTip[] {
  const mine = entries.filter((e) => e.lexicon === "pulumi");
  const tips: PulumiPreviewTip[] = [];
  const base = (e: ChangeSetEntry) => ({ member: e.member, address: e.address, type: e.type, ...(e.name !== undefined ? { name: e.name } : {}) });

  // rename-without-aliases
  const creates = mine.filter((e) => e.action === "create" && e.mayAppear !== true && e.name !== undefined);
  const taken = new Set<string>();
  for (const del of mine) {
    if (del.action !== "delete" || del.mayAppear === true || del.name === undefined) continue;
    const stem = nameStem(del.name);
    if (!stem) continue;
    const match = creates.find((c) => !taken.has(c.address) && c.member === del.member && c.type === del.type && c.address !== del.address && nameStem(c.name!) === stem);
    if (!match) continue;
    taken.add(match.address);
    tips.push({ id: "rename-without-aliases", ...base(del), created: { address: match.address, ...(match.name !== undefined ? { name: match.name } : {}) } });
  }

  // replace-on-name
  for (const e of mine) {
    if (e.action !== "replace" || e.disruption === "destroy") continue;
    const inputs = e.attributes.filter((a) => a.forcesReplacement === true && NAME_INPUT.test(a.path)).map((a) => a.path);
    if (inputs.length > 0) tips.push({ id: "replace-on-name", ...base(e), inputs });
  }

  // unknown-in-apply
  for (const e of mine) {
    if (e.mayAppear === true) tips.push({ id: "unknown-in-apply", ...base(e) });
  }
  return tips;
}

const code = (s: string): string => "`" + s.replace(/`/g, "'") + "`";

/** What the row says the preview showed. */
function seen(t: PulumiPreviewTip): string {
  switch (t.id) {
    case "rename-without-aliases":
      return `deleted, and ${code(t.created?.name ?? t.created?.address ?? "?")} of the same type created, with no alias between them`;
    case "replace-on-name":
      return `replaced because ${t.inputs!.map(code).join(", ")} changed, creating the new one before deleting the old`;
    case "unknown-in-apply":
      return "may register at up: the preview could not list it";
  }
}

/** The words the detail section reads: the product's name and its noun. */
export interface PulumiTipWords {
  product: string;
  noun: [string, string];
}

/**
 * The note's detail section for one member's tips (`prNoteDetail`), or
 * undefined when it has none. One row per tip, with its id first. A product
 * other than chant gets a closing line naming `<product> tips <id>`, the
 * command its words give the fix with.
 */
export function pulumiTipsDetail(input: { member: string; changeSet: Pick<ChangeSetDocument, "entries">; words?: PulumiTipWords }): { title: string; lines: string[] } | undefined {
  const tips = pulumiPreviewTips(input.changeSet.entries.filter((e) => e.member === input.member));
  if (tips.length === 0) return undefined;
  const words = input.words ?? { product: "chant", noun: ["member", "members"] };
  const lines = ["| Tip | Resource | Preview |", "|---|---|---|"];
  for (const t of tips) lines.push(`| ${code(t.id)} | ${code(t.type)} ${code(t.name ?? t.address)} | ${seen(t)} |`);
  if (words.product !== "chant") {
    const ids = [...new Set(tips.map((t) => t.id))];
    lines.push("", `${ids.map((id) => code(`${words.product} tips ${id}`)).join(", ")} ${ids.length === 1 ? "prints the fix" : "print the fixes"}.`);
  }
  const noun = words.noun[0];
  return { title: `Tips for ${noun} ${code(input.member)} (${tips.length})`, lines };
}
