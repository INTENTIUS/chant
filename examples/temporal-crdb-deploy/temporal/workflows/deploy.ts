/**
 * deployMultiRegionCRDB — durable workflow for a CockroachDB multi-region
 * deployment on GKE, split across two layers:
 *
 *   • Argo CD owns the declarative apply. The workflow bootstraps the Argo
 *     Applications once (authored in src/argo via ArgoAppFor /
 *     ArgoAppSetForRegions) and then *waits* for Argo to converge with
 *     waitForArgoSync. The old hand-written apply activities — applySharedInfra,
 *     applyRegionalInfra, installESO, applyK8sManifests — and the StatefulSet
 *     rollout wait are gone; Argo Health=Healthy subsumes them.
 *
 *   • Temporal keeps only the genuinely procedural steps Argo can't express:
 *     the DNS-delegation gate (signal/update/auto-poll race), Docker-based cert
 *     generation, pushing secrets out-of-band to Secret Manager, the one-shot
 *     `cockroach init`, region topology, and the backup schedule.
 *
 * Temporal patterns still demonstrated: signal + update + query, an auto/manual
 * race via condition(), parallel waits with Promise.all, and search attributes.
 */
import {
  proxyActivities,
  proxyLocalActivities,
  condition,
  setHandler,
  defineSignal,
  defineQuery,
  defineUpdate,
} from '@temporalio/workflow';

// `import type` erases at runtime — the workflow sandbox never loads the activity
// modules; Temporal resolves them by name via the worker's registry.
import type * as InfraActivities from '../activities/infra.js';
import type * as K8sActivities from '../activities/kubernetes.js';
import type * as CrdbActivities from '../activities/cockroachdb.js';
import type * as CertsActivities from '../activities/certs.js';
import type * as ArgoActivities from '../activities/argo.js';

import type { DeployParams } from '../types.js';
import { Phase, ARGO_APPS } from '../types.js';

// ─── Signals / Queries / Updates ───────────────────────────────────────────────

/** Sent by the operator after configuring DNS delegation at the registrar. */
export const dnsConfiguredSignal = defineSignal('dns-configured');
/** Returns the current Phase enum value — readable from the CLI or Temporal UI. */
export const currentPhaseQuery = defineQuery<Phase>('current-phase');
/** Returns the Cloud DNS nameservers for the east/central/west public zones. */
export const nameserversQuery = defineQuery<string[]>('nameservers');
/** Bidirectional RPC: checks whether NS delegation is live for each zone. */
export const validateDnsUpdate = defineUpdate<{ ready: boolean; missing: string[] }>('validate-dns');

// ─── Activity proxies ───────────────────────────────────────────────────────────

// Fast, idempotent: build output YAML, fetch nameservers (<5 min each).
const { buildStacks, fetchNameservers } = proxyActivities<typeof InfraActivities>({
  startToCloseTimeout: '5m',
  retry: { maximumAttempts: 3, initialInterval: '5s', backoffCoefficient: 2 },
});

// Auto-DNS detection: polls dig for NS delegation up to 45 min, heartbeating.
const { waitForDnsDelegation } = proxyActivities<typeof InfraActivities>({
  startToCloseTimeout: '50m',
  heartbeatTimeout: '90s',
  retry: { maximumAttempts: 1 }, // timeout means "not delegated"; the signal still works
});

// Argo bootstrap (apply the Application objects) — fast, idempotent kubectl apply.
const { applyArgoInfra, applyArgoWorkload } = proxyActivities<typeof ArgoActivities>({
  startToCloseTimeout: '5m',
  retry: { maximumAttempts: 5, initialInterval: '5s', backoffCoefficient: 2 },
});

// Wait for Argo to converge — long timeout, 60s heartbeat, cheap idempotent
// retries (matches the lexicon's argoSync profile). A terminal-unhealthy app
// fails fast via ArgoSyncFailedError.
const { waitForArgoSync } = proxyActivities<typeof ArgoActivities>({
  startToCloseTimeout: '30m',
  heartbeatTimeout: '60s',
  retry: {
    maximumAttempts: 5,
    initialInterval: '10s',
    backoffCoefficient: 2,
    maximumInterval: '1m',
    nonRetryableErrorTypes: ['ArgoSyncFailedError'],
  },
});

// K8s credential setup — fast but worth retrying.
const { configureKubectl, waitForExternalDNS } = proxyActivities<typeof K8sActivities>({
  startToCloseTimeout: '15m',
  heartbeatTimeout: '60s',
  retry: { maximumAttempts: 5, initialInterval: '5s', backoffCoefficient: 2 },
});

const { initializeCockroachDB, configureMultiRegion, setupBackupSchedule } =
  proxyActivities<typeof CrdbActivities>({
    startToCloseTimeout: '10m',
    retry: { maximumAttempts: 3, initialInterval: '10s', backoffCoefficient: 2 },
  });

const { generateAndDistributeCerts, pushSecretsToSecretManager } =
  proxyActivities<typeof CertsActivities>({
    startToCloseTimeout: '10m',
    retry: { maximumAttempts: 3, initialInterval: '10s', backoffCoefficient: 2 },
  });

// Local activity: dig check for the validate-dns update handler.
const { checkDnsZones } = proxyLocalActivities<typeof InfraActivities>({
  startToCloseTimeout: '30s',
});

/** Wait for a set of Argo Applications to all reach Healthy + Synced. */
function syncAll(apps: readonly string[]): Promise<unknown> {
  return Promise.all(apps.map((appName) => waitForArgoSync({ appName, namespace: 'argocd' })));
}

// ─── Workflow ───────────────────────────────────────────────────────────────────

export async function deployMultiRegionCRDB(params: DeployParams): Promise<void> {
  let currentPhase = Phase.BUILD;
  let dnsConfigured = false;
  const nameservers: string[] = [];

  setHandler(currentPhaseQuery, () => currentPhase);
  setHandler(nameserversQuery, () => nameservers);
  setHandler(dnsConfiguredSignal, () => { dnsConfigured = true; });
  setHandler(validateDnsUpdate, async () => checkDnsZones(params.crdbDomain));

  // ── Build all output manifests (workload YAML + Argo bootstrap) ───────────
  await buildStacks(params);

  // ── Infra: let Argo reconcile the Config Connector resources (GKE clusters) ─
  // One bootstrap apply of the infra Applications, then wait for Argo to report
  // Healthy — that's the GKE clusters Ready. Replaces applySharedInfra +
  // applyRegionalInfra(×3).
  currentPhase = Phase.APPLY_ARGO_INFRA;
  await applyArgoInfra(params);
  currentPhase = Phase.SYNC_INFRA;
  await syncAll(ARGO_APPS.infra);

  // ── Fetch nameservers for the DNS delegation gate ─────────────────────────
  const ns = await fetchNameservers(params);
  ns.forEach((n) => nameservers.push(n));

  // ── DNS delegation gate (stays in Temporal) ───────────────────────────────
  // Argo can't model this: NS records are configured out-of-band at the
  // registrar. Auto-detection (dig poll) races the manual 'dns-configured'
  // signal; whichever fires first unblocks the workflow.
  currentPhase = Phase.WAIT_DNS_DELEGATION;
  void waitForDnsDelegation(params).then(() => { dnsConfigured = true; }).catch(() => {
    console.log('Auto-DNS detection did not confirm delegation — waiting for manual dns-configured signal');
  });
  await condition(() => dnsConfigured, '48h');

  // ── kubectl credentials for the 3 workload clusters ───────────────────────
  currentPhase = Phase.CONFIGURE_KUBECTL;
  await configureKubectl(params);

  // ── TLS certs (Docker-based, out-of-band; stays in Temporal) ──────────────
  currentPhase = Phase.GENERATE_CERTS;
  await generateAndDistributeCerts(params);

  // ── Workload Argo apps: register the workload clusters + ESO + CRDB ────────
  // The cluster-registration Secrets need endpoints that only exist now that
  // SYNC_INFRA created the clusters, so this bootstrap apply runs here.
  currentPhase = Phase.APPLY_ARGO_WORKLOAD;
  await applyArgoWorkload(params);

  // ESO (Helm) reconciled by Argo — replaces installESO(×3).
  currentPhase = Phase.SYNC_ESO;
  await syncAll(ARGO_APPS.eso);

  // ── Push TLS certs to Secret Manager (out-of-band; stays in Temporal) ──────
  // ESO ExternalSecrets then sync them into K8s Secrets.
  currentPhase = Phase.PUSH_SECRETS;
  await pushSecretsToSecretManager(params);

  // ── CockroachDB workloads reconciled by Argo ──────────────────────────────
  // Replaces applyK8sManifests(×3) AND waitForStatefulSets(×3) — Argo
  // Health=Healthy means the StatefulSets rolled out.
  currentPhase = Phase.SYNC_K8S;
  await syncAll(ARGO_APPS.k8s);

  // ── Wait for ExternalDNS A-records (out-of-band DNS; stays in Temporal) ────
  currentPhase = Phase.WAIT_DNS_RECORDS;
  await waitForExternalDNS(params);

  // ── One-shot procedural steps Argo can't express ──────────────────────────
  currentPhase = Phase.INIT_CRDB;
  await initializeCockroachDB(params);

  currentPhase = Phase.CONFIGURE_REGIONS;
  await configureMultiRegion(params);

  currentPhase = Phase.SETUP_BACKUP;
  await setupBackupSchedule(params);

  currentPhase = Phase.COMPLETE;
}
