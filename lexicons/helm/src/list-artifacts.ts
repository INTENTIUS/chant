/**
 * Live introspection of Helm releases via `helm list -A -o json`.
 *
 * The Helm lexicon's chant entities describe chart-authoring primitives
 * (Chart.yaml, templates/, values.yaml). The runtime concept — a Helm
 * release installed in a kubeconfig context — is created by `helm install`
 * outside chant's entity model. This implementation reports those releases
 * as artifacts so `state diff --live` / `WatchOp` can detect manual
 * installs/upgrades/rollbacks that slip past CI.
 *
 * Helm-not-installed (binary missing) → returns `{}` cleanly so other
 * lexicons' snapshots aren't blocked.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ArtifactMetadata } from "@intentius/chant/lexicon";
import { loadChantConfigUpward } from "@intentius/chant/config";
import { resolveClusterTarget } from "@intentius/chant/kubectl-context";
import { readReleaseLedger, latestPerComponent, type ReleaseRecord } from "@intentius/chant/lifecycle/release-ledger";

const execAsync = promisify(exec);

/**
 * The render identity a chant deploy recorded for a release (#2031). `helm
 * list` cannot know which bytes a release was installed from — but the
 * release ledger already records it on deploy (#1243): the input digest for
 * an unpinned deploy, contentDigest + inputDigest for a pinned one. This
 * reads that record back, so an observed release joins `helm renders` /
 * `helm diff` by digest instead of by chart-name prefix matching.
 *
 * The join key is the ledger record's `component`, which the helm deploy
 * activity defaults to the release name (`args.component ?? args.name`,
 * ./op/activities/helm.ts). Deliberately best-effort and honest about
 * absence:
 *
 *  - a release deployed outside chant has no record, and reports nothing;
 *  - a ledger that cannot be read (no repo, no lifecycle branch) joins
 *    nothing rather than failing the snapshot;
 *  - two observed releases sharing one name (different namespaces) are
 *    ambiguous — the record does not carry a namespace — so neither joins;
 *  - a record whose `component` was overridden away from the release name
 *    does not join (the honest miss, same as today).
 */
function renderIdentityOf(
  record: ReleaseRecord | undefined,
): { inputDigest?: string; contentDigest?: string } {
  if (!record) return {};
  if (record.inputDigest) {
    // Pinned deploy (#1242): `digest` is the render's contentDigest, the
    // input identity rides alongside.
    return { inputDigest: record.inputDigest, contentDigest: record.digest };
  }
  // Unpinned deploy: the record is keyed by the input digest itself
  // (`ReleaseRecord.inputDigest` is "absent when digest is already input-side").
  return { inputDigest: record.digest };
}

interface HelmListEntry {
  name?: string;
  namespace?: string;
  revision?: string;
  updated?: string;
  status?: string;
  chart?: string;
  app_version?: string;
}

function pruneUndefined<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export async function listArtifacts(options: {
  environment: string;
  entities: Map<string, { entityType: string; props: Record<string, unknown> }>;
}): Promise<Record<string, ArtifactMetadata>> {
  const result: Record<string, ArtifactMetadata> = {};

  // The same cluster binding every other helm read resolves (chant#1488 —
  // `k8s.profiles.<env>.context`, shared with the k8s lexicon). Listing on
  // the AMBIENT context read whichever cluster the operator's shell last
  // pointed at: verified live on kubemicrovm-ops, whose releases came back
  // `{}` because the shell's current-context was an unrelated EKS cluster.
  // Unresolvable → ambient, which is chant's own fallback when no profile is
  // declared.
  let context: string | undefined;
  try {
    const { config } = await loadChantConfigUpward(process.cwd());
    context = (await resolveClusterTarget(config as Record<string, unknown>, options.environment, "helm")).context;
  } catch {
    context = undefined;
  }

  let stdout: string;
  try {
    ({ stdout } = await execAsync(`helm list -A -o json${context ? ` --kube-context '${context.replace(/'/g, "'\\''")}'` : ""}`));
  } catch {
    // Binary not installed, no kubeconfig, or some other error — return
    // empty rather than blocking the whole snapshot.
    return result;
  }

  let entries: HelmListEntry[];
  try {
    entries = JSON.parse(stdout);
  } catch {
    return result;
  }

  // The environment's latest release record per component (#2031) — the
  // deploy-side identity read back. Best-effort: an unreadable ledger joins
  // nothing rather than blocking the snapshot.
  let recorded: Map<string, ReleaseRecord> = new Map();
  try {
    const { records } = await readReleaseLedger(options.environment);
    recorded = latestPerComponent(records);
  } catch {
    recorded = new Map();
  }

  // A name observed in several namespaces is ambiguous against a record that
  // carries no namespace — neither joins.
  const nameCounts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.name) nameCounts.set(entry.name, (nameCounts.get(entry.name) ?? 0) + 1);
  }

  for (const entry of entries) {
    if (!entry.name || !entry.namespace) continue;
    const key = `release/${entry.namespace}/${entry.name}`;
    const record = nameCounts.get(entry.name) === 1 ? recorded.get(entry.name) : undefined;
    const { inputDigest, contentDigest } = renderIdentityOf(record);
    result[key] = {
      type: "Helm::Release",
      physicalId: `${entry.namespace}/${entry.name}`,
      status: entry.status ?? "unknown",
      lastUpdated: entry.updated,
      attributes: pruneUndefined({
        chart: entry.chart,
        revision: entry.revision,
        appVersion: entry.app_version,
        namespace: entry.namespace,
        inputDigest,
        contentDigest,
      }),
    };
  }

  return result;
}
