/**
 * The identity contract (#1982) — which principal chant would act as in each
 * substrate, reported before it acts.
 *
 * Every native observer already resolves this. `ObserverAdapter.bind()`
 * (./observation.ts) reaches the provider on the applier's own transport, the
 * k8s connector resolves a kubeconfig context and says which binding produced
 * it, the aws read client resolves a region and an endpoint. All of it is
 * discarded. The only way the answer has ever surfaced is as an `unobserved`
 * entry with reason `no-credentials`, or — worse — as a successful read
 * against the wrong account.
 *
 * A project spanning aws, k8s, gcp and github reaches four substrates with
 * four credential sets, and nothing says which identity each one resolves to.
 * `chant lifecycle whoami <env>` asks each configured lexicon that question
 * and prints one row per lexicon.
 *
 * ## The tri-state
 *
 * The same discipline the observation contract draws between "absent" and
 * "not observed" applies here, because the same mistake is available: an empty
 * identity reads as "nobody", and "nobody" is not what "I could not find out"
 * means.
 *
 *   - **REPORTED** — the lexicon asked the substrate and it answered. A
 *     principal, a scope, and where the binding came from.
 *   - **UNRESOLVED** — the lexicon tried and could not, carrying a total
 *     {@link UnobservedReason}. `no-credentials` is "no identity is
 *     configured"; `no-binding` and `read-failed` are "could not determine".
 *     Those are different answers and the reason keeps them apart.
 *   - **NOT REPORTED** — the lexicon implements no {@link
 *     import("./lexicon").LexiconPlugin.describeIdentity}. It answers for
 *     nothing, which is honest; it is never rendered as an empty identity.
 *
 * ## Read-only, and never a gate
 *
 * `whoami` mutates nothing and blocks nothing. It exits 0 whatever the rows
 * say unless the caller asks for a non-zero exit on an unresolved row with
 * `--strict`. A lexicon's implementation is held to the same rule: a self-query
 * that reaches the substrate must be one the substrate treats as a read of the
 * caller's own identity.
 *
 * ## No credential ever reaches the output
 *
 * An identity is a principal and a scope — an account id, a project, an org, a
 * cluster context, a service-account name. It is never a token, a key, a
 * password or a certificate. The rule is on the lexicon: report the fact, not
 * the value, and where a substrate's only identity signal IS a secret, say so
 * without it.
 *
 * {@link redactCredentialMaterial} is the backstop core applies to every field
 * of every row regardless, not a license to be careless. It is deliberately
 * structural rather than heuristic — it redacts what the process actually
 * holds in a credential-shaped environment variable, plus the three literal
 * shapes (PEM block, JWT, `Bearer …`) that no principal string can be — so an
 * account id, an ARN and a `system:serviceaccount:…` subject survive it intact.
 */

import type { UnobservedReason } from "./observation";

/** The identity one lexicon resolved, and the scope it resolves to. */
export interface ResolvedIdentity {
  /**
   * The principal, as the substrate names it — an STS ARN, a
   * `system:serviceaccount:<ns>:<name>` subject, a service-account email. Never
   * a credential.
   */
  identity: string;
  /**
   * What that principal is scoped to here — an account id plus region, a
   * cluster context, a project, an org. The half that answers "acting on
   * WHAT", which is where a wrong-account read is actually visible.
   */
  scope: string;
  /**
   * Where the binding came from, in the project's own vocabulary:
   * `k8s.profiles.prod.context`, `AWS_PROFILE`, `ADC`, `stacks[].region`. An
   * identity with no provenance cannot be corrected by whoever reads it.
   */
  source: string;
  /**
   * The resolved address the self-query was issued against. Must be the address
   * this lexicon's live read resolves for the same environment — a whoami that
   * reports a binding the read does not use is worse than no whoami.
   */
  endpoint?: string;
}

/** Why one lexicon could not resolve an identity. Total, and reason-typed. */
export interface UnresolvedIdentity {
  /**
   * Total verdict, from the same set an unobservable entity uses.
   * `no-credentials` — nothing is configured to act as. `no-binding` — the
   * environment resolves to no concrete target. `read-failed` — the substrate
   * was reached and the self-query errored.
   */
  reason: UnobservedReason;
  /** Human-readable detail: the call that failed, the missing binding key. */
  detail?: string;
}

/**
 * What `describeIdentity()` may return: the resolved identity, or a typed
 * refusal. Discriminated by the `unresolved` key, the same shape
 * {@link import("./observation").EntityObservation} uses.
 */
export type DescribeIdentityResult = ResolvedIdentity | { unresolved: UnresolvedIdentity };

/** True when a lexicon answered with a typed refusal rather than an identity. */
export function isUnresolvedIdentity(
  value: DescribeIdentityResult,
): value is { unresolved: UnresolvedIdentity } {
  return typeof value === "object" && value !== null && "unresolved" in value;
}

/** The tri-state, as one row's verdict. */
export type IdentityStatus = "reported" | "unresolved" | "not-reported";

/** One lexicon's answer, normalized — the unit `whoami` renders and `--json` emits. */
export interface IdentityRow {
  lexicon: string;
  status: IdentityStatus;
  /** REPORTED only. */
  identity?: string;
  /** REPORTED only. */
  scope?: string;
  /** REPORTED only. */
  source?: string;
  /** REPORTED only, and only when the lexicon named one. */
  endpoint?: string;
  /** UNRESOLVED only. */
  reason?: UnobservedReason;
  /** UNRESOLVED only, when the lexicon supplied one. */
  detail?: string;
}

/** What core hands a lexicon's `describeIdentity`. */
export interface DescribeIdentityOptions {
  environment: string;
  /**
   * The region the environment's stacks declare, when they declare exactly one
   * (`stacks[].region`, #1261). Omitted when they declare none or disagree, in
   * which case the lexicon resolves the region its own read path would.
   */
  region?: string;
  /** Project root whose `chant.config.ts` carries the binding. Defaults to cwd. */
  cwd?: string;
}

/** The subset of a plugin this module needs — narrower than importing the whole contract. */
export interface IdentityPlugin {
  name: string;
  describeIdentity?(options: DescribeIdentityOptions): Promise<DescribeIdentityResult>;
}

/** The marker a redacted field carries. Fixed text so a consumer can match it. */
export const REDACTED = "[redacted]";

/**
 * Environment variables whose VALUE is credential material. Matched on the
 * name, so a lexicon that echoes one of these into an identity string has the
 * value removed before it is printed or serialized.
 */
const CREDENTIAL_ENV_NAME =
  /(SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|APIKEY|API_KEY|ACCESS_KEY|SESSION_KEY|AUTH)/i;

/** Shortest env value worth redacting. Below this a "secret" is a false positive. */
const MIN_CREDENTIAL_LENGTH = 8;

/**
 * Literal credential shapes. Each is something a principal string cannot be,
 * so matching one is proof rather than a guess.
 */
const CREDENTIAL_SHAPES: RegExp[] = [
  // A PEM block of any key type.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // A JWT: three base64url segments, the first starting with the `{"` header.
  /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g,
  // An `Authorization`-style scheme plus its value.
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9\-._~+/]{16,}={0,2}/g,
];

/**
 * Strip credential material from one reported field.
 *
 * Two rules, both structural. Any value this process holds in a
 * credential-named environment variable is replaced wherever it appears, which
 * covers the realistic accident — a lexicon echoing `$GITHUB_TOKEN` or
 * `$AWS_SECRET_ACCESS_KEY` into a `source`. And the three literal shapes above
 * are replaced on sight.
 *
 * Nothing is entropy-scored, so an ARN, an account id, a service-account email
 * and a cluster context name pass through unchanged — which matters, because a
 * mangled principal is a wrong answer, not a safe one.
 */
export function redactCredentialMaterial(
  value: string,
  env: Record<string, string | undefined> = process.env,
): string {
  let out = value;
  for (const [name, secret] of Object.entries(env)) {
    if (!secret || secret.length < MIN_CREDENTIAL_LENGTH) continue;
    if (!CREDENTIAL_ENV_NAME.test(name)) continue;
    if (!out.includes(secret)) continue;
    out = out.split(secret).join(REDACTED);
  }
  for (const shape of CREDENTIAL_SHAPES) out = out.replace(shape, REDACTED);
  return out;
}

/** Apply {@link redactCredentialMaterial} to every free-text field of a row. */
export function redactIdentityRow(
  row: IdentityRow,
  env: Record<string, string | undefined> = process.env,
): IdentityRow {
  const clean = (v: string | undefined): string | undefined =>
    v === undefined ? undefined : redactCredentialMaterial(v, env);
  return {
    ...row,
    ...(row.identity !== undefined ? { identity: clean(row.identity) } : {}),
    ...(row.scope !== undefined ? { scope: clean(row.scope) } : {}),
    ...(row.source !== undefined ? { source: clean(row.source) } : {}),
    ...(row.endpoint !== undefined ? { endpoint: clean(row.endpoint) } : {}),
    ...(row.detail !== undefined ? { detail: clean(row.detail) } : {}),
  };
}

/**
 * Normalize one lexicon's answer into a row.
 *
 * Every degradation lands somewhere honest. No method at all is NOT REPORTED.
 * A throw is UNRESOLVED with `read-failed` — the lexicon reached for the
 * substrate and something broke, which is a different claim from having no
 * credentials. An answer that carries no identity string is UNRESOLVED too: a
 * lexicon cannot report an empty principal, because an empty principal renders
 * as "acting as nobody", and nobody is a claim.
 */
export function identityRowFor(
  lexicon: string,
  result: DescribeIdentityResult | undefined,
  env: Record<string, string | undefined> = process.env,
): IdentityRow {
  if (result === undefined) return { lexicon, status: "not-reported" };
  if (isUnresolvedIdentity(result)) {
    return redactIdentityRow(
      {
        lexicon,
        status: "unresolved",
        reason: result.unresolved.reason,
        ...(result.unresolved.detail ? { detail: result.unresolved.detail } : {}),
      },
      env,
    );
  }
  if (!result.identity || result.identity.trim() === "") {
    return {
      lexicon,
      status: "unresolved",
      reason: "read-failed",
      detail: "the lexicon reported an identity with no principal in it",
    };
  }
  return redactIdentityRow(
    {
      lexicon,
      status: "reported",
      identity: result.identity,
      scope: result.scope,
      source: result.source,
      ...(result.endpoint ? { endpoint: result.endpoint } : {}),
    },
    env,
  );
}

/**
 * Ask every plugin who it would act as. One call per lexicon, concurrently,
 * in the order the plugins were configured so the report is stable.
 *
 * A plugin that throws never fails the run: the throw becomes that lexicon's
 * UNRESOLVED row. Reporting is the whole point, and a report that aborts on
 * the first broken substrate is exactly the report nobody can use.
 */
export async function describeIdentities(
  plugins: readonly IdentityPlugin[],
  options: DescribeIdentityOptions,
  env: Record<string, string | undefined> = process.env,
): Promise<IdentityRow[]> {
  return Promise.all(
    plugins.map(async (plugin): Promise<IdentityRow> => {
      if (!plugin.describeIdentity) return { lexicon: plugin.name, status: "not-reported" };
      try {
        return identityRowFor(plugin.name, await plugin.describeIdentity(options), env);
      } catch (err) {
        return identityRowFor(
          plugin.name,
          {
            unresolved: {
              reason: "read-failed",
              detail: err instanceof Error ? err.message : String(err),
            },
          },
          env,
        );
      }
    }),
  );
}

/**
 * A row's verdict as one short cell, for the IDENTITY column. Deliberately
 * without the `detail`, which is a sentence and belongs under the table rather
 * than inside a column every other row has to be padded to.
 */
export function identityStatusText(row: IdentityRow): string {
  switch (row.status) {
    case "reported":
      return row.identity ?? "";
    case "unresolved":
      return `could not determine — ${unresolvedReasonText(row.reason)}`;
    case "not-reported":
      return "not reported — this lexicon does not answer for an identity";
  }
}

/**
 * Why an identity did not resolve, in words. Deliberately distinct from
 * `unobservedReasonText`: `no-credentials` here means "no identity is
 * configured for this substrate", which is an answer, not a failure to look.
 */
export function unresolvedReasonText(reason: UnobservedReason | undefined): string {
  switch (reason) {
    case "no-credentials":
      return "no identity is configured for this substrate";
    case "no-binding":
      return "this environment resolves to no target";
    case "read-failed":
      return "the substrate was reached and the self-query failed";
    case "unsupported-kind":
      return "the substrate exposes no self-query";
    case "filtered":
      return "withheld";
    default:
      return "no reason given";
  }
}
