/**
 * GCP read transport (#1209) — the applier's own REST client, pointed at the
 * read side.
 *
 * GCP applies cluster-free over direct REST (#706) and, until this, observed
 * through a Config Connector cluster: `kubectl get <cnrm-gvk> -o json` per
 * entity, on both the thin and the deep path. That split is what #1085's
 * principle forbids — a lexicon should be observed on the transport it is
 * applied with, or the two can disagree about what a resource even is — and it
 * is what made GCP the heaviest of the three O slots.
 *
 * ## The URL comes from the applier, not from here
 *
 * Every GET is built by the same `ResourceMapper.plan()` the applier uses, and
 * this module reads `plan().getUrl` rather than composing its own URL. That is
 * deliberate: a reader that builds its own paths is a second, silently
 * divergent opinion about where a resource lives, and the first symptom is a
 * read that reports absent for something the applier just wrote. Reusing the
 * mapper makes the two structurally incapable of disagreeing.
 *
 * ## What that bounds
 *
 * Coverage is exactly the applier's dispatch table (`MAPPERS`) — StorageBucket,
 * PubSubTopic, PubSubSubscription, SecretManagerSecret, IAMServiceAccount,
 * RunService. The kubectl path could fetch any CNRM kind the cluster knew
 * about, so this is narrower on paper. It is not narrower in practice for
 * anything chant can act on: a kind with no mapper cannot be applied either, so
 * observing it produced a live tree nothing could ever reconcile against.
 *
 * A kind outside the table reports NOT-OBSERVED with `unsupported-kind` rather
 * than being dropped, so the estate says "chant did not look at this" instead of
 * quietly implying it is not there. Widening the table is #1209's stated
 * non-goal and belongs with the applier.
 */
import { MAPPERS, type GcpResource, type ResourceMapper } from "../op/activities/gcp-apply";

/** Where to read, and as whom. */
export interface GcpReadClientOptions {
  /** Endpoint override for every kind (floci-gcp `http://localhost:4588`). Omit for real GCP. */
  endpoint?: string;
  /** GCP project the resources live in. */
  project: string;
  /** Injectable HTTP, so tests never touch the network. */
  http?: GcpReadHttp;
}

/** Injectable HTTP client — mirrors the applier's `GcpHttp`. */
export type GcpReadHttp = (method: string, url: string) => Promise<{ status: number; text: string }>;

const defaultHttp: GcpReadHttp = async (method, url) => {
  const res = await fetch(url, { method });
  return { status: res.status, text: await res.text() };
};

/**
 * A read that failed for a reason the caller must classify — carries the HTTP
 * status so a 404 (absent) is told apart from a 401/403 (no credentials) and a
 * 5xx/network error (could not look). Mirrors `AzureReadError`.
 */
export class GcpReadError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GcpReadError";
  }
}

/** A 404 — the resource is genuinely absent, which is an answer, not a failure. */
export function isNotFound(err: unknown): boolean {
  return err instanceof GcpReadError && err.status === 404;
}

/** The mapper for a CNRM kind, or undefined when chant cannot act on it. */
export function mapperForKind(kind: string): ResourceMapper | undefined {
  return MAPPERS[kind];
}

/**
 * GET one resource on the applier's transport.
 *
 * `declared` is the entity's own declared spec, which is what `plan()` needs to
 * build a URL — the same input the applier hands it. Returns the parsed body,
 * or throws {@link GcpReadError} carrying the status.
 */
export async function getResource(
  client: GcpReadClientOptions,
  kind: string,
  name: string,
  declared?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const mapper = mapperForKind(kind);
  if (!mapper) throw new GcpReadError(`no REST mapper for kind ${kind}`);

  const base = (client.endpoint ?? mapper.defaultHost).replace(/\/$/, "");
  const resource: GcpResource = {
    kind,
    metadata: { name },
    spec: (declared?.spec as Record<string, unknown> | undefined) ?? declared ?? {},
  };

  let getUrl: string;
  try {
    getUrl = mapper.plan(resource, { base, project: client.project }).getUrl;
  } catch (err) {
    // A mapper that cannot plan from the declared spec cannot produce a URL, so
    // there is nothing to read — a hole, never an absence.
    throw new GcpReadError(`could not build a read URL for ${kind}/${name}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const http = client.http ?? defaultHttp;
  let res: { status: number; text: string };
  try {
    res = await http("GET", getUrl);
  } catch (err) {
    throw new GcpReadError(err instanceof Error ? err.message : String(err));
  }

  if (res.status === 404) throw new GcpReadError(`${kind}/${name} not found`, 404);
  if (res.status < 200 || res.status >= 300) {
    throw new GcpReadError(`GET ${kind}/${name} failed with ${res.status}: ${res.text.slice(0, 200)}`, res.status);
  }
  try {
    return JSON.parse(res.text) as Record<string, unknown>;
  } catch {
    throw new GcpReadError(`GET ${kind}/${name} returned a non-JSON body`, res.status);
  }
}
