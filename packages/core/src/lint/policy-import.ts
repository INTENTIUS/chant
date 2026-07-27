/**
 * The single place chant imports a project's `lint.policies` module **in the
 * CLI's own process** — and the flag that says it may not.
 *
 * The third member of the same family as `../discovery/import.ts`'s
 * `importModule` (project source) and `../config-import.ts`'s
 * `importConfigModule` (`chant.config.ts`): one narrow module whose only job is
 * "execute project-authored code here", so that "did any project code run in
 * this process?" has one place to look and one place to instrument — see
 * `examples/sandbox-execution-boundary.test.ts`, which spies on all three.
 *
 * Before chant #1131 `./policy.ts` called `await import(resolved)` inline,
 * which is why the corpus boundary gate could not see it even after #1113 put
 * the config behind the boundary: there was nothing named to wrap.
 *
 * The armed flag lives here rather than in `./policy-sandbox.ts` (which owns
 * the *decision* and documents the reasoning, and re-exports these three
 * functions as its public surface) for one structural reason: `./policy.ts`
 * needs to consult it, `./policy-sandbox.ts` needs to call `./policy.ts`, and a
 * flag on a leaf module with no imports of its own breaks what would otherwise
 * be an import cycle. It also puts the check on the narrowest possible thing —
 * the function that actually executes project code — rather than on a caller
 * that might forget to ask.
 */

/** Whether this process must run project policy modules inside the sandbox boundary instead of here. */
let armed = false;

/**
 * Arm sandboxed policy execution for the rest of this process. See
 * `./policy-sandbox.ts` for what arms it and why it is a process mode rather
 * than a threaded option. Idempotent; there is deliberately no disarm.
 */
export function armSandboxPolicyExecution(): void {
  armed = true;
}

/** Whether {@link armSandboxPolicyExecution} has been called. */
export function isSandboxPolicyExecutionArmed(): boolean {
  return armed;
}

/** Test-only reset — vitest gives each test file its own module registry, so this exists for suites that arm and disarm within one file. */
export function resetSandboxPolicyExecutionForTests(): void {
  armed = false;
}

/** The shape a policy module evaluates to — chant reads its exported values and keeps the `PostSynthCheck`-shaped ones. */
export type PolicyModuleNamespace = Record<string, unknown>;

/**
 * Import a policy module into THIS process and return its module namespace.
 * Node's ESM registry caches it, so repeated loads within one CLI invocation
 * evaluate the file once.
 *
 * Refuses while armed. Under `--sandbox` the policy modules are imported inside
 * a child process (`../discovery/sandbox/policy-run.ts`); arriving here anyway
 * means something is about to execute project-authored code in the CLI's own
 * process, which is exactly what the flag promises does not happen. Falling
 * through would make `--sandbox` mean less than it says with nothing visible to
 * notice, so this throws instead.
 */
export async function importPolicyModule(policyPath: string): Promise<PolicyModuleNamespace> {
  if (armed) {
    throw new Error(
      `Refusing to import the policy module ${policyPath} into the chant process under --sandbox: it is project-authored code and must be imported inside the sandbox boundary (packages/core/src/lint/policy-sandbox.ts's runProjectPolicies).`,
    );
  }
  return (await import(policyPath)) as PolicyModuleNamespace;
}
