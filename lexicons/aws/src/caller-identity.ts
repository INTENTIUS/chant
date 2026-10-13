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
 * Resolved the way the AWS CLI resolves them (#3954), by
 * `./api/credential-chain.ts`: environment keys, then the profile
 * `AWS_PROFILE` names (or `default`) from the shared config and credentials
 * files, through static keys, `role_arn`, SSO sessions and
 * `credential_process`. Before #3954 only the environment keys were read, so
 * `AWS_PROFILE=dev` on an SSO session answered "no identity is configured"
 * while `aws sts get-caller-identity` answered with a principal. An expired
 * SSO session is `no-credentials` naming `aws sso login --profile <p>`.
 *
 * The native read transport still signs with environment keys only
 * (`resolveCredentials` in ./api/sigv4.ts; #3958). So a profile-sourced row says
 * what the CLI, and anything shelling out to it, would act as; it does not
 * yet say what `describeResources` signs with. The `source` column names the
 * profile, so the difference is visible.
 *
 * Against an endpoint override the chain is not walked: the emulator call is
 * unsigned whatever resolves, and a whoami against Floci should not start an
 * SSO refresh or a `credential_process`.
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
import { resolveCredentialChain, type CredentialChainOptions } from "./api/credential-chain";

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

/** The environment-key label, used against an endpoint override where the chain is not walked. */
function envCredentialLabel(env: Record<string, string | undefined>): string | undefined {
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) return undefined;
  return env.AWS_SESSION_TOKEN
    ? "env AWS_ACCESS_KEY_ID + AWS_SESSION_TOKEN"
    : "env AWS_ACCESS_KEY_ID";
}

/** Options this module needs beyond the contract — the injectable transport, for tests. */
export interface CallerIdentityOptions extends DescribeIdentityOptions {
  client?: AwsReadClientOptions;
  /**
   * The credential chain's seams: shared-file reads, the SSO and
   * `credential_process` transports, the clock. Its `env` defaults to the
   * client's, and its STS transport to the client's `http`.
   */
  chain?: CredentialChainOptions;
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

  // Against an emulator the call is unsigned by design (Floci verifies no
  // signature), so an absent credential is not yet a refusal — the emulator
  // answers with the identity it models — and the chain is not walked.
  let credential: string | undefined;
  if (override) {
    credential = envCredentialLabel(env);
  } else if (client.credentials) {
    credential = "credentials injected by the caller";
  } else {
    const chain = await resolveCredentialChain({
      env,
      ...options.chain,
      sts: { ...(client.http ? { http: client.http } : {}), ...options.chain?.sts, env },
    });
    if ("unresolved" in chain) return { unresolved: chain.unresolved };
    credential = chain.resolved.source;
    client.credentials = chain.resolved.credentials;
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
