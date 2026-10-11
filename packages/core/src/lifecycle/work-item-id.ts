/**
 * What a work item id has to be to key a work lease (#2815). The id lands in
 * refs (`refs/chant/lease/work/<id>`, `refs/chant/kept/.../<item>/<token>`,
 * the work branch `chant/work/.../<id>`) and in a file name
 * (`_leases/<id>.jsonl`), so it has to be a valid ref path segment under
 * `git check-ref-format`, and git's check is stricter than a character class.
 *
 * Kept free of imports so `Op()`, `declareSteward` and the CLI can all call it
 * without loading the lease machinery.
 */

/** The characters an id may use: letters, digits, ".", "_" and "-", starting with a letter or digit, at most 100. */
export const WORK_ITEM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * Why `id` can't key a work lease, or `undefined` when it can. On top of
 * {@link WORK_ITEM_ID_PATTERN}, git refuses a ref component that has `..`,
 * ends in `.`, or ends in `.lock` (git's own lock file for the ref; matched
 * case-insensitively here since a case-folding filesystem would collide).
 */
export function workItemIdProblem(id: unknown): string | undefined {
  if (typeof id !== "string") return `${JSON.stringify(id)} is not a string`;
  if (!WORK_ITEM_ID_PATTERN.test(id)) {
    return `${JSON.stringify(id)} can't key a work lease: use letters, digits, ".", "_" and "-", starting with a letter or digit, at most 100 characters`;
  }
  if (id.includes("..")) return `${JSON.stringify(id)} can't key a work lease: git refuses ".." in a ref name`;
  if (id.endsWith(".")) return `${JSON.stringify(id)} can't key a work lease: git refuses a ref name ending in "."`;
  if (id.toLowerCase().endsWith(".lock")) return `${JSON.stringify(id)} can't key a work lease: git refuses a ref name ending in ".lock"`;
  return undefined;
}

/** Whether `id` can key a work lease. */
export function isWorkItemId(id: unknown): id is string {
  return workItemIdProblem(id) === undefined;
}
