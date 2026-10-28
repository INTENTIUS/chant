/**
 * `chant ci check-job` (#4624): the apply-job guard as a command, for a
 * product that renders its own jobs (`plywood ci check-job`, `terragucci ci
 * check-job` through the product's bin). It reads the job's expectation
 * from CHANT_JOB_GUARD, as the generated op-wave step does, checks it
 * against what the forge tells the job, and exits chant's `failed` (1)
 * with one line per value that differs. See ../../ci-job-guard.ts.
 */
import type { CommandContext } from "../registry";

export async function runCiCheckJob(_ctx: CommandContext, env: NodeJS.ProcessEnv = process.env, fetchFn: typeof fetch = fetch): Promise<number> {
  const [{ parseJobGuardSpec, jobSeen, checkJob, describeJobGuard, JOB_GUARD_ENV }, { CHANT_EXIT }, { activeProductWords }] = await Promise.all([
    import("../../ci-job-guard"),
    import("../../exit-codes"),
    import("../../ci-product-words"),
  ]);
  let spec;
  try {
    spec = parseJobGuardSpec(env[JOB_GUARD_ENV]);
  } catch (err) {
    console.error(`${activeProductWords().product} check-job: ${err instanceof Error ? err.message : String(err)}`);
    return CHANT_EXIT.failed;
  }
  if (spec.product === undefined) {
    const product = activeProductWords().product;
    if (product !== "chant") spec = { ...spec, product };
  }
  const seen = await jobSeen(spec, env, fetchFn);
  const { ok, out, err } = describeJobGuard(spec, checkJob(spec, seen));
  for (const line of out) console.log(line);
  for (const line of err) console.error(line);
  return ok ? CHANT_EXIT.done : CHANT_EXIT.failed;
}
