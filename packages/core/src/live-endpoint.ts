/**
 * chant #1166 — let a declared `environment` carry its own endpoint so
 * `--live --env <name>` is self-sufficient.
 *
 * The bug this closes: `chant graph --live --env floci` (and `lifecycle
 * diff`/`plan`) observe a stack by shelling out through each lexicon's
 * `describeResources()`. For AWS that shell-out honors the ambient
 * `AWS_ENDPOINT_URL` env var — when a project's `floci` environment is a local
 * emulator (`http://localhost:4566`) but the invoking shell never exported
 * that var, the AWS CLI silently targets real AWS instead. The stack named
 * after the environment doesn't exist there, so `describeResources` hits its
 * `stackDoesNotExist` branch and returns an empty, unremarkable "nothing is
 * deployed" — indistinguishable from the truthful answer. This cost real
 * debugging time validating #1162's live overlay: the observation code was
 * right, the manual repro just never set the var.
 *
 * The fix: `environments` in `chant.config.ts` can name an endpoint per
 * environment (`config.ts`'s `EnvironmentDeclaration`), and {@link
 * applyLiveEndpoint} injects it into the ambient env var each observing
 * lexicon's CLI shell-out actually reads — but only for a var that isn't
 * already set. Ambient always wins: a shell that already exports
 * `AWS_ENDPOINT_URL` sees no change in behavior.
 *
 * Audited (#1166) which lexicons have an ambient-env-var endpoint knob at
 * all, since that's the specific footgun — a lexicon whose environment
 * binding is resolved from `chant.config` itself (not an ambient var) has
 * nothing to inject here:
 *
 *   - **aws**  — `AWS_ENDPOINT_URL`, read directly by
 *     `lexicons/aws/src/components/cloud-executor.ts` / `plugin.ts` before
 *     every `aws …` shell-out (`applyAwsEndpoint`/`applyAwsEndpointArgv`).
 *   - **fly**  — `FLY_FLAPS_BASE_URL`, read by `resolveEndpoint()` in
 *     `lexicons/fly/src/op/activities/fly-apply.ts`, the same seam
 *     `describeResources` (`../describe-resources.ts`) calls through.
 *   - **gcp**, **k8s** — resolve their live target from `chant.config` itself
 *     (`k8s.profiles.<env>.context` via `resolveClusterTarget`,
 *     `packages/core/src/kubectl-context.ts`), not an ambient var. Nothing to
 *     inject: the config *is* the binding already.
 *   - **azure** — resolves via the `az` CLI's own logged-in
 *     subscription/session context; no ambient endpoint var exists to miss.
 *   - **temporal** — resolves its connection from `temporal.profiles.<env>`
 *     (`resolveProfile`, `lexicons/temporal/src/describe-resources.ts`), the
 *     same "config is the binding" shape as k8s/gcp.
 */

import { environmentEndpoint, type EnvironmentDeclaration } from "./config";

/**
 * Per-lexicon ambient env var a `--live` read honors for its endpoint. Only
 * lexicons with a genuine ambient-var footgun are listed — see the module doc
 * for the full audit (gcp/k8s/azure/temporal resolve their target from
 * `chant.config` instead, so they have nothing to inject).
 */
export const LEXICON_ENDPOINT_ENV_VAR: Record<string, string> = {
  aws: "AWS_ENDPOINT_URL",
  fly: "FLY_FLAPS_BASE_URL",
};

/** Result of {@link applyLiveEndpoint} — always call `restore()`, even when nothing was applied (it is then a no-op). */
export interface AppliedEndpoint {
  /**
   * One line describing what happened, or `undefined` when the environment
   * declares no endpoint at all (nothing to say). Present whether the
   * declared endpoint was applied OR an ambient var already won — #1166's
   * "no silent anything" stance: an operator should never have to guess which
   * target a `--live` read actually used.
   */
  notice?: string;
  /** Undo whatever ambient env vars this call set. Always safe to call. */
  restore: () => void;
}

/**
 * Resolve `environment`'s declared endpoint (if any) from `config.environments`
 * and apply it to the ambient env var of every lexicon in `lexicons` that has
 * one ({@link LEXICON_ENDPOINT_ENV_VAR}) — but only when that var isn't
 * already set. Ambient always wins (#1166): behavior for a shell that already
 * exports `AWS_ENDPOINT_URL` is unchanged.
 *
 * Call before a `--live` describe/enrich pass; `restore()` in a `finally` so
 * the injected value never leaks into a later invocation in the same process
 * (tests, or a long-lived host like the MCP server).
 */
export function applyLiveEndpoint(
  environments: EnvironmentDeclaration[] | undefined,
  environment: string,
  lexicons: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): AppliedEndpoint {
  const endpoint = environmentEndpoint(environments, environment);
  if (!endpoint) return { restore: () => {} };

  const applied: string[] = [];
  const overridden: string[] = [];
  const seen = new Set<string>(); // a var shared by two lexicons is only reported once
  for (const lexicon of lexicons) {
    const varName = LEXICON_ENDPOINT_ENV_VAR[lexicon];
    if (!varName || seen.has(varName)) continue;
    seen.add(varName);
    if (env[varName]) {
      overridden.push(varName);
      continue;
    }
    env[varName] = endpoint;
    applied.push(varName);
  }

  const notices: string[] = [];
  if (applied.length > 0) {
    notices.push(
      `environment "${environment}" declares endpoint ${endpoint} — applied to ${applied.join(", ")} for this read`,
    );
  }
  if (overridden.length > 0) {
    notices.push(
      `ambient ${overridden.join(", ")} already set — keeping it over environment "${environment}"'s declared endpoint (${endpoint})`,
    );
  }

  return {
    notice: notices.length > 0 ? notices.join("; ") : undefined,
    restore: () => {
      for (const varName of applied) delete env[varName];
    },
  };
}

/**
 * #1166 acceptance: when a `--live` describe comes back with zero resources
 * for a lexicon that had declared entities to look for, and nothing was
 * already reported NOT-OBSERVED (#1089) either, that is either "genuinely
 * nothing is deployed yet" or a misconfigured endpoint/credentials — the two
 * are visually identical, so a caller must say so rather than stay quiet.
 * Returns `undefined` when there is nothing to declare (no declared entities
 * to have asked about, or the emptiness is already explained by #1089's
 * `unobserved`).
 */
export function zeroResourcesWarning(
  lexicon: string,
  environment: string,
  declaredCount: number,
  observed: { resources: Record<string, unknown>; unobserved: Record<string, unknown> },
): string | undefined {
  if (declaredCount === 0) return undefined;
  if (Object.keys(observed.resources).length > 0) return undefined;
  if (Object.keys(observed.unobserved).length > 0) return undefined;
  return `${lexicon}: 0 live resources for env "${environment}" (${declaredCount} declared) — check the endpoint/credentials`;
}
