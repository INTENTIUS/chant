/**
 * Who chant would act as in AWS — the lexicon half of `chant lifecycle whoami`
 * (chant #1982).
 *
 * `sts:GetCallerIdentity` on the same transport every read uses, so the answer
 * cannot describe a target the read does not reach: the endpoint override, the
 * region and the signing decision are resolved by `read-client.ts` once, for
 * both. That parity is the point of the command — a whoami that reports real
 * AWS while `describeResources` reads Floci is worse than none — and a test
 * pins it.
 *
 * ## What the region actually is
 *
 * The native read transport takes its region from the stack being observed
 * (`stacks[].region`, #1261) and falls back to `us-east-1` inside `serviceUrl`.
 * It does NOT read `AWS_REGION`. So that is what is reported, including the
 * awkward case: an operator whose shell exports `AWS_REGION=eu-west-1` and
 * whose project declares no stack region is reading us-east-1, and has had no
 * way to find that out short of a wrong answer. `source` names it.
 *
 * ## Credentials
 *
 * `resolveCredentials` (./api/sigv4.ts) reads `AWS_ACCESS_KEY_ID` /
 * `AWS_SECRET_ACCESS_KEY` and nothing else — no profile file, no IMDS, no
 * container endpoint, deliberately. `AWS_PROFILE` alone therefore signs
 * nothing, and against real AWS the call comes back unauthorized. That is
 * reported as `no-credentials` naming the profile, which is a far better
 * answer than an empty stack read an hour later.
 *
 * No credential value is ever returned. The identity is the principal ARN the
 * service itself answers with, and the scope is an account and a region.
 */

import type { DescribeIdentityOptions, DescribeIdentityResult } from "@intentius/chant/lexicon";
import {
  AwsReadError,
  getCallerIdentity,
  resolveEndpointOverride,
  serviceUrl,
  type AwsReadClientOptions,
} from "./api/read-client";
import { resolveCredentials } from "./api/sigv4";

/** The region the read transport falls back to when no stack declares one. */
const DEFAULT_REGION = "us-east-1";

/** True when the failure says the call was refused rather than broken. */
function isAuthFailure(err: AwsReadError): boolean {
  if (err.status === 401 || err.status === 403) return true;
  return /credential|token|expired|AccessDenied|not authorized|Unauthorized|InvalidClientTokenId|SignatureDoesNotMatch/i.test(
    `${err.code ?? ""} ${err.message}`,
  );
}

/** Where the region came from, said plainly enough to act on. */
function regionSource(declared: string | undefined, env: Record<string, string | undefined>): string {
  if (declared) return `stacks[].region`;
  const ambient = env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
  if (ambient && ambient !== DEFAULT_REGION) {
    return `chant default (no stacks[].region; AWS_REGION=${ambient} is not read by this transport)`;
  }
  return "chant default (no stacks[].region)";
}

/** Where the signature came from, without any part of the credential itself. */
function credentialSource(env: Record<string, string | undefined>): string | undefined {
  if (!resolveCredentials(undefined, env)) return undefined;
  return env.AWS_SESSION_TOKEN
    ? "env AWS_ACCESS_KEY_ID + AWS_SESSION_TOKEN"
    : "env AWS_ACCESS_KEY_ID";
}

/** Options this module needs beyond the contract — the injectable transport, for tests. */
export interface CallerIdentityOptions extends DescribeIdentityOptions {
  client?: AwsReadClientOptions;
}

/**
 * The AWS `describeIdentity`. Returns the STS principal and the account+region
 * scope, or a typed refusal — never a guessed identity and never an empty one.
 */
export async function describeIdentity(options: CallerIdentityOptions): Promise<DescribeIdentityResult> {
  const client: AwsReadClientOptions = {
    ...options.client,
    ...(options.region ? { region: options.region } : {}),
  };
  const env = client.env ?? process.env;
  const override = resolveEndpointOverride("sts", client.endpoint, env);
  // The region the transport resolves, not the one an operator might assume:
  // `serviceUrl` defaults it, so this is the host the read is actually sent to.
  const region = client.region ?? DEFAULT_REGION;
  const endpoint = serviceUrl("sts", override, client.region);

  const credential = credentialSource(env);
  // Against an emulator the call is unsigned by design (Floci verifies no
  // signature), so an absent credential is not yet a refusal — the emulator
  // answers with the identity it models. Against real AWS it is.
  if (!credential && !override) {
    return {
      unresolved: {
        reason: "no-credentials",
        detail: env.AWS_PROFILE
          ? `no AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in the environment; AWS_PROFILE=${env.AWS_PROFILE} is set, but chant's native transport reads only the environment credentials, not the profile file`
          : "no AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in the environment",
      },
    };
  }

  let identity;
  try {
    identity = await getCallerIdentity(client);
  } catch (err) {
    if (err instanceof AwsReadError) {
      return {
        unresolved: {
          reason: isAuthFailure(err) ? "no-credentials" : "read-failed",
          detail: `sts:GetCallerIdentity against ${endpoint} failed: ${err.code ? `${err.code}: ` : ""}${err.message}`,
        },
      };
    }
    return {
      unresolved: {
        reason: "read-failed",
        detail: `sts:GetCallerIdentity against ${endpoint} failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  if (!identity.arn) {
    return {
      unresolved: {
        reason: "read-failed",
        detail: `sts:GetCallerIdentity against ${endpoint} answered without an Arn`,
      },
    };
  }

  const sources = [
    credential ?? "unsigned (endpoint override)",
    regionSource(client.region, env),
    ...(override ? [`endpoint override ${override}`] : []),
  ];
  return {
    identity: identity.arn,
    scope: identity.account ? `${identity.account} ${region}` : region,
    source: sources.join("; "),
    endpoint,
  };
}
