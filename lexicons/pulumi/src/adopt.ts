/**
 * Adopting a stock Pulumi stack onto plunge's per-resource records (#4562):
 * the pieces `PulumiAdoptOp` (`./composites/pulumi-adopt-op.ts`) and its
 * activities (`./op/activities/pulumi-adopt.ts`) share.
 *
 * - {@link parsePlungeAdoptView}: the document `plunge stack adopt --json`
 *   prints (plunge `pkg/backend/plunge` `AdoptView`, its site's
 *   reference/adopt-json page): `status` is `would-adopt`, `adopted`,
 *   `already-adopted` or `refused`, with each resource's fate and every
 *   refusal.
 * - {@link pulumiAdoptDigest}: what the Op's gate binds. It covers the
 *   stack, the checkpoint's digest and source, and each resource's URN,
 *   type, ID and fate, and leaves `status` out, so the preview an approver
 *   saw and the `--yes` run that follows digest the same when nothing moved.
 * - {@link pulumiStackBackend} and {@link adoptBucketTarget}: the stack's
 *   backend URL, and the bucket the shared check (#4558) reads from it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BucketTarget } from "@intentius/chant/bucket-check";
import { computePlanDigest } from "@intentius/chant/lifecycle/plan-digest";
import { parseYAML } from "@intentius/chant/yaml";
import { readPlywoodEngine } from "./member-engine";
import { isObject } from "./values";

/** `AdoptView.status`. */
export type PlungeAdoptStatus = "would-adopt" | "adopted" | "already-adopted" | "refused";

export interface PlungeAdoptRefusal {
  code: string;
  urn?: string;
  reason: string;
}

export interface PlungeAdoptResource {
  urn: string;
  type: string;
  id: string;
  /** `marker`, `record`, `pending` or `already-adopted`. */
  fate: string;
  adoptedAs?: string;
  marked?: boolean;
  reason?: string;
}

/** The parts of plunge's `AdoptView` chant reads. */
export interface PlungeAdoptView {
  stack: string;
  status: PlungeAdoptStatus;
  checkpoint: { source?: string; digest?: string };
  resources: PlungeAdoptResource[];
  refusals: PlungeAdoptRefusal[];
}

const STATUSES: ReadonlySet<string> = new Set(["would-adopt", "adopted", "already-adopted", "refused"]);

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** The adopt document, or undefined when `text` is not one. */
export function parsePlungeAdoptView(text: string | undefined): PlungeAdoptView | undefined {
  if (!text) return undefined;
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(doc) || typeof doc.status !== "string" || !STATUSES.has(doc.status)) return undefined;
  const checkpoint = isObject(doc.checkpoint) ? doc.checkpoint : {};
  const resources = (Array.isArray(doc.resources) ? doc.resources : []).filter(isObject).map(
    (r): PlungeAdoptResource => ({
      urn: str(r.urn) ?? "",
      type: str(r.type) ?? "",
      id: str(r.id) ?? "",
      fate: str(r.fate) ?? "",
      ...(str(r.adoptedAs) ? { adoptedAs: str(r.adoptedAs) } : {}),
      ...(typeof r.marked === "boolean" ? { marked: r.marked } : {}),
      ...(str(r.reason) ? { reason: str(r.reason) } : {}),
    }),
  );
  const refusals = (Array.isArray(doc.refusals) ? doc.refusals : []).filter(isObject).map(
    (r): PlungeAdoptRefusal => ({ code: str(r.code) ?? "", ...(str(r.urn) ? { urn: str(r.urn) } : {}), reason: str(r.reason) ?? "" }),
  );
  return {
    stack: str(doc.stack) ?? "",
    status: doc.status as PlungeAdoptStatus,
    checkpoint: { ...(str(checkpoint.source) ? { source: str(checkpoint.source) } : {}), ...(str(checkpoint.digest) ? { digest: str(checkpoint.digest) } : {}) },
    resources,
    refusals,
  };
}

/** The gate's digest over an adopt document (see the module comment). */
export function pulumiAdoptDigest(view: PlungeAdoptView): string {
  const resources = view.resources
    .map((r) => ({ urn: r.urn, type: r.type, id: r.id, fate: r.fate === "already-adopted" ? (r.adoptedAs ?? r.fate) : r.fate }))
    .sort((a, b) => (a.urn < b.urn ? -1 : a.urn > b.urn ? 1 : 0));
  return computePlanDigest("plunge-adopt", { stack: view.stack, checkpoint: view.checkpoint.digest ?? null, resources });
}

/** Counts by fate. */
export function adoptFates(view: PlungeAdoptView): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of view.resources) out[r.fate] = (out[r.fate] ?? 0) + 1;
  return out;
}

/** The stack's backend URL and where it came from, first that answers: the step's, `plywood.yml`'s, `PULUMI_BACKEND_URL`, `Pulumi.yaml`'s. */
export function pulumiStackBackend(
  dir: string,
  opts: { configured?: string; env?: Record<string, string | undefined> } = {},
): { url: string; source: string } | undefined {
  if (opts.configured) return { url: opts.configured, source: "the step's backend" };
  const plywood = readPlywoodEngine(dir);
  if (plywood?.backend) return { url: plywood.backend, source: plywood.file };
  const env = (opts.env ?? process.env).PULUMI_BACKEND_URL;
  if (env) return { url: env, source: "PULUMI_BACKEND_URL" };
  const file = join(dir, "Pulumi.yaml");
  if (existsSync(file)) {
    try {
      const url = (parseYAML(readFileSync(file, "utf-8")).backend as { url?: unknown } | undefined)?.url;
      if (typeof url === "string") return { url, source: "Pulumi.yaml" };
    } catch {
      // No backend named.
    }
  }
  return undefined;
}

/** The stock backend at the same root: the URL without plunge's `plunge+` prefix. */
export function stockBackendUrl(url: string): string {
  return url.replace(/^plunge\+/, "");
}

/** What the bucket check reads for a backend, or why it does not run. */
export type AdoptBucketTarget =
  | { target: BucketTarget; namespaces: string[]; waived: string[] }
  | { skip: string }
  | { refuse: string };

/**
 * The bucket behind a DIY backend URL, for the shared check (#4558). An
 * `s3://` URL gives the bucket, its `region` (else `AWS_REGION`), its
 * `endpoint` with static keys from the environment, and the path as the
 * namespace a lifecycle rule must cover; `gs://` gives the bucket. A
 * `file://` backend has no bucket, and the check is skipped with that
 * reason. An `azblob://` URL does not name the subscription and resource
 * group the check reads, so it is refused unless the step names the bucket
 * itself. `allow_insecure` on the URL and `PLUNGE_ALLOW_INSECURE` are read as
 * plunge reads them.
 */
export function adoptBucketTarget(url: string, env: Record<string, string | undefined> = process.env): AdoptBucketTarget {
  const stock = stockBackendUrl(url);
  let u: URL;
  try {
    u = new URL(stock);
  } catch {
    return { refuse: `the backend ${url} is not a URL the bucket check can read` };
  }
  const waived = [
    ...(u.searchParams.get("allow_insecure") ?? "").split(","),
    ...(env.PLUNGE_ALLOW_INSECURE ?? "").split(","),
  ]
    .map((s) => s.trim())
    .filter(Boolean);
  const prefix = u.pathname.replace(/^\/+/, "");
  const namespaces = prefix ? [prefix.endsWith("/") ? prefix : `${prefix}/`] : [];
  switch (u.protocol) {
    case "file:":
      return { skip: `the backend ${url} is a local file path, which has no bucket to check` };
    case "s3:": {
      const region = u.searchParams.get("region") ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
      if (!region) return { refuse: `the backend ${url} names no region and AWS_REGION is not set, so the bucket check cannot read ${u.hostname}` };
      const endpoint = u.searchParams.get("endpoint") ?? undefined;
      if (endpoint && !(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY)) {
        return { refuse: `the backend ${url} names the endpoint ${endpoint}, and the bucket check reads an endpoint only with static keys (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)` };
      }
      const target: BucketTarget = {
        store: "s3",
        bucket: u.hostname,
        region,
        ...(endpoint
          ? {
              endpoint: /^[a-z]+:\/\//.test(endpoint) ? endpoint : `https://${endpoint}`,
              credentials: {
                accessKeyId: env.AWS_ACCESS_KEY_ID!,
                secretAccessKey: env.AWS_SECRET_ACCESS_KEY!,
                ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
              },
            }
          : {}),
      } as BucketTarget;
      return { target, namespaces, waived };
    }
    case "gs:":
      return { target: { store: "gcs", bucket: u.hostname } as BucketTarget, namespaces, waived };
    case "azblob:":
      return { refuse: `the backend ${url} does not name the storage account's subscription and resource group; set the step's bucket to the azblob target` };
    default:
      return { refuse: `the backend ${url} is not a bucket plunge stores records in (s3, gs, azblob or file)` };
  }
}
