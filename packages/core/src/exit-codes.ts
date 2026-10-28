/**
 * chant's one exit-code table (#4553), for every command that runs, gates or
 * applies a plan, and for both products built on chant CI (terragucci and
 * plywood). The terraform, pulumi and sql lexicons map their engines' own codes
 * onto it (`terraformExitOf` in `@intentius/chant-lexicon-terraform/exit-codes`,
 * `pulumiExitOf` in `@intentius/chant-lexicon-pulumi`, `sqlExitOf` in
 * `@intentius/chant-lexicon-sql/exit-codes`), and a product passes
 * the code through unchanged.
 *
 * The numbers are the ones op waves already used, so a pipeline reading op
 * waves' 3 to 8 sees no change. 9 is the apply-job guard's (#4624). A moved plan is 4 and a waiting run 3; before
 * this table both were 3 outside op waves.
 *
 * A usage or config error has no code of its own: it is `failed`, 1.
 *
 * The reference page is docs/src/content/docs/reference/exit-codes.mdx.
 */
export const CHANT_EXIT = {
  /** Applied, or nothing to do. */
  done: 0,
  /** Something broke, and no approval changes it. Usage and config errors too. */
  failed: 1,
  /** A run asked to fail on drift found some (`--fail-on-drift`, `failOn: "drift"`). */
  drift: 2,
  /**
   * Stopped for a person: a gate, an open decision point, a review that does
   * not count yet, unmet requires, an earlier wave waiting, no pull request
   * found. The only code `--gated-exit` remaps.
   */
  waiting: 3,
  /** An approved plan no longer matches the plan that would apply now, so nothing applied. */
  moved: 4,
  /** Another run or open pull request holds a lock on a target or resource this changes, so nothing applied. */
  held: 5,
  /** A newer push applies instead. */
  superseded: 6,
  /** The policy denied the plan and no override counts, at plan and at apply. */
  denied: 7,
  /** A decision point answered with an answer the gate does not pass on. */
  declined: 8,
  /**
   * The apply-job guard stopped the job (#4624): it runs somewhere its spec
   * did not set it to run, or it carries no spec the guard can read. Outside
   * the GitLab op-wave jobs' allowed failure (1), so the waves after it stop.
   */
  misplaced: 9,
} as const;

/** A name in {@link CHANT_EXIT}. */
export type ChantExitName = keyof typeof CHANT_EXIT;

/** A code in {@link CHANT_EXIT}. */
export type ChantExitCode = (typeof CHANT_EXIT)[ChantExitName];

/** The name of `code` in {@link CHANT_EXIT}, or `undefined` for a code outside the table. */
export function chantExitName(code: number): ChantExitName | undefined {
  for (const [name, value] of Object.entries(CHANT_EXIT)) {
    if (value === code) return name as ChantExitName;
  }
  return undefined;
}
