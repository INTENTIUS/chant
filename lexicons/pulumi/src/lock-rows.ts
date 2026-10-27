/**
 * The rows a Pulumi or plunge apply holds on the resource lock grain
 * (#4552), from the member's change-set part (`./change-set.ts`):
 *
 * - `urn <urn>` for every resource the preview changes (create, update,
 *   replace, delete or forget). The URN carries the project and the stack,
 *   so two stacks never meet on a URN row.
 * - `object <id>` for an update, replace, delete or forget whose resource
 *   has an id, so two members that act on one live object meet on its row,
 *   whatever lexicon or stack they are in.
 * - The root `pulumi:pulumi:Stack` URN's row when its step is not `same`:
 *   two runs that rewrite the stack's outputs serialize. It is one more
 *   changed entry, so it needs no rule of its own.
 * - When any entry is `mayAppear` (a component may register children only
 *   at apply, or the last export holds a resource the preview did not list),
 *   one `stack <project>/<stack>` row in place of the URN rows (ruling C),
 *   which conflicts with every `urn` row of the stack. The `object` rows stay.
 *
 * `same` and `read` steps hold nothing.
 */
import type { ChangeSetPart } from "@intentius/chant/change-set";
import { objectRowKey, sortedLockRows, stackRowKey, urnRowKey, type LockRow } from "@intentius/chant/lifecycle/lock-rows";
import { parsePulumiUrn } from "@intentius/chant/pulumi-urn";

const HOLDS = new Set(["create", "update", "replace", "delete", "forget"]);

/** The project and stack a part's URNs name, or the fallbacks when no URN parses. */
function stackOf(part: ChangeSetPart, fallback: { project?: string; stack?: string }): { project: string; stack: string } | undefined {
  for (const e of part.entries) {
    const parsed = parsePulumiUrn(e.address);
    if (parsed) return { project: parsed.project, stack: parsed.stack };
  }
  const stack = part.member.scope ?? fallback.stack;
  return fallback.project && stack ? { project: fallback.project, stack } : undefined;
}

/**
 * The rows of one Pulumi member's part. `target` names the member in a
 * refusal (`<project>/<stack>`); `fallback` gives the project and stack when
 * no entry's address is a URN.
 */
export function pulumiLockRows(part: ChangeSetPart, target: string, fallback: { project?: string; stack?: string } = {}): LockRow[] {
  const changing = part.entries.filter((e) => HOLDS.has(e.action));
  const rows: LockRow[] = [];
  for (const e of changing) {
    if (e.action !== "create" && e.id) rows.push({ key: objectRowKey(e.id), target, address: e.address });
  }
  if (changing.some((e) => e.mayAppear === true)) {
    const at = stackOf(part, fallback);
    if (!at) throw new Error(`"${target}": some resources of the stack may appear only at apply, and neither a URN nor the step names the stack, so its row cannot be keyed`);
    rows.push({ key: stackRowKey(at.project, at.stack), target, address: `${at.project}/${at.stack}` });
    return sortedLockRows(rows);
  }
  for (const e of changing) rows.push({ key: urnRowKey(e.address), target, address: e.address });
  return sortedLockRows(rows);
}
