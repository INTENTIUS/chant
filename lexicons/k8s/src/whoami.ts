/**
 * Who chant would act as in a cluster — the lexicon half of `chant lifecycle
 * whoami` (chant #1982).
 *
 * The connector already resolves all of this and hands it back on every
 * observation: `defaultK8sConnector` picks a context from
 * `k8s.profiles.<env>.context` or from the ambient kubeconfig, the client
 * records the server it resolved and which credential path authorized it, and
 * `describeResources` then throws the lot away. This reports it, and reports
 * it BEFORE a read rather than after a wrong one.
 *
 * Same connector, same environment, same options, so the server named here is
 * the server the read talks to. A test pins that: a whoami that names a
 * cluster the read does not use would be worse than no whoami at all.
 *
 * ## The principal is the API server's answer, not the kubeconfig's
 *
 * A kubeconfig `user` entry is a local alias. The cluster may map that
 * credential onto any subject it likes, which is exactly why "am I acting as
 * the identity I think I am" is a real question. So the principal comes from
 * `SelfSubjectReview` — the call behind `kubectl auth whoami` — which the API
 * server answers with the subject it authenticated. It creates nothing.
 *
 * A cluster older than the review API serves no version of it. That is
 * `read-failed` with a detail saying so, not a fallback to the local alias
 * dressed up as an identity.
 *
 * ## No credential in the answer
 *
 * The credential path is reported by NAME — `exec-plugin` and its command,
 * `token`, `client-certificate`. A kubeconfig holding a static bearer token is
 * the case where the identity signal IS a secret, and the report says
 * `credential: token` and stops there. The token, the client key and the exec
 * plugin's output never leave the client.
 */

import type { DescribeIdentityOptions, DescribeIdentityResult } from "@intentius/chant/lexicon";
import { defaultK8sConnector, type K8sConnector } from "./api/connect";
import { classifyApiFailure, isMissingClientPackage, MISSING_CLIENT_DETAIL } from "./api/classify";

/** Everything about the caller's credential except the credential. */
function credentialNote(credential: string, execCommand?: string): string {
  return execCommand ? `credential ${credential} (${execCommand})` : `credential ${credential}`;
}

/**
 * The k8s `describeIdentity`. Connects the way the read connects, asks the API
 * server who it is talking to, and reports the context that binding came from.
 */
export async function describeIdentity(
  options: DescribeIdentityOptions,
  connect: K8sConnector = defaultK8sConnector,
): Promise<DescribeIdentityResult> {
  let connected;
  try {
    connected = await connect({ environment: options.environment, cwd: options.cwd });
  } catch (err) {
    if (isMissingClientPackage(err)) {
      return { unresolved: { reason: "read-failed", detail: MISSING_CLIENT_DETAIL } };
    }
    const outcome = classifyApiFailure(err);
    return {
      unresolved:
        outcome.kind === "unobserved"
          ? { reason: outcome.reason, detail: outcome.detail }
          : { reason: "no-binding", detail: err instanceof Error ? err.message : String(err) },
    };
  }

  const { client, target } = connected;
  const provenance = client.provenance;
  const context = provenance.context ?? "(unset)";
  const scope = `${context} ns=${client.defaultNamespace}`;
  // Where the context came from, in the project's own vocabulary. An ambient
  // context is not a failure — but it is the one an operator most often did
  // not mean, so it says which binding is missing.
  const binding =
    target.source === "bound"
      ? `k8s.profiles.${options.environment}.context`
      : `ambient kubeconfig current-context (no k8s.profiles.${options.environment} binding)`;
  const source = [
    binding,
    credentialNote(provenance.credential, provenance.execCommand),
    `kubeconfig ${provenance.kubeconfigSource}`,
  ].join("; ");

  let subject;
  try {
    subject = await client.selfSubjectReview();
  } catch (err) {
    const outcome = classifyApiFailure(err);
    return {
      unresolved: {
        reason: outcome.kind === "unobserved" ? outcome.reason : "read-failed",
        detail:
          outcome.kind === "unobserved"
            ? `SelfSubjectReview against ${provenance.server}: ${outcome.detail}`
            : `SelfSubjectReview against ${provenance.server} did not answer`,
      },
    };
  }

  if (!subject) {
    return {
      unresolved: {
        reason: "read-failed",
        detail:
          `${provenance.server} serves no authentication.k8s.io SelfSubjectReview, so the API server ` +
          `cannot be asked who it authenticated (the API landed in Kubernetes 1.26). The kubeconfig ` +
          `context is "${context}" with ${credentialNote(provenance.credential, provenance.execCommand)}, ` +
          `which names a local credential entry, not the subject the cluster resolves it to.`,
      },
    };
  }

  return {
    identity: subject.username,
    scope,
    source,
    endpoint: provenance.server,
  };
}
