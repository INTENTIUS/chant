/**
 * deployMultiRegionCRDB — durable workflow that orchestrates a 13-phase
 * CockroachDB multi-region deployment on GKE.
 *
 * Key Temporal patterns demonstrated:
 *   • proxyActivities with per-group timeout + retry config
 *   • Activity heartbeat on long-running infra waits (GKE cluster creation,
 *     StatefulSet rollout, DNS record propagation)
 *   • Signal — manual override for DNS delegation ('dns-configured')
 *   • Update — validate-dns RPC: caller gets a structured response back
 *   • Query — inspect current phase without looking at logs ('current-phase')
 *   • Promise.all — parallel regional deploys (activities run concurrently)
 *   • Auto-DNS detection: waitForDnsDelegation races the condition() gate;
 *     whichever resolves first (activity or signal) unblocks the workflow
 *   • Search attributes — tag the workflow with GcpProject + CrdbDomain for
 *     filtering in the Temporal Cloud UI
 *   • Workflow ID deduplication — re-running with the same ID is a no-op if
 *     the workflow is still running; resume happens automatically on restart
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

// `import type` erases to nothing at runtime — workflow sandbox never loads
// the activity modules. Temporal resolves them by name via the worker's registry.
import type * as InfraActivities from '../activities/infra.js';
import type * as K8sActivities from '../activities/kubernetes.js';
import type * as CrdbActivities from '../activities/cockroachdb.js';
import type * as CertsActivities from '../activities/certs.js';

import type { DeployParams } from '../types.js';
import { Phase } from '../types.js';

// ─── Signals ──────────────────────────────────────────────────────────────────

/** Sent by the operator after configuring DNS delegation at the registrar. */
export const dnsConfiguredSignal = defineSignal('dns-configured');

// ─── Queries ──────────────────────────────────────────────────────────────────

/** Returns the current Phase enum value — readable from the CLI or Temporal UI. */
export const currentPhaseQuery = defineQuery<Phase>('current-phase');

/** Returns the Cloud DNS nameservers for the east/central/west public zones. */
export const nameserversQuery = defineQuery<string[]>('nameservers');

// ─── Updates ──────────────────────────────────────────────────────────────────

/**
 * Bidirectional RPC: checks whether NS delegation is live for each zone.
 * Returns { ready: boolean; missing: string[] } — caller sees the result immediately.
 * Unlike a signal, this blocks until the check completes and echoes back the result.
 */
export const validateDnsUpdate = defineUpdate<{ ready: boolean; missing: string[] }>('validate-dns');

// ─── Activity proxies ─────────────────────────────────────────────────────────
// Multiple proxyActivities calls from the same type are fine — each gets its
// own timeout/retry config applied at scheduling time.

// Fast, idempotent: build output YAML, apply manifests (<5 min each)
const { buildStacks, applySharedInfra, fetchNameservers } = proxyActivities<typeof InfraActivities>({
  startToCloseTimeout: '5m',
  retry: { maximumAttempts: 3, initialInterval: '5s', backoffCoefficient: 2 },
});

// Long-running: GKE cluster creation via Config Connector (~10-15 min per region)
// Must heartbeat; 60 s timeout = Temporal considers the activity dead if silent > 60 s
const { applyRegionalInfra } = proxyActivities<typeof InfraActivities>({
  startToCloseTimeout: '20m',
  heartbeatTimeout: '60s',
  retry: { maximumAttempts: 3, initialInterval: '30s', backoffCoefficient: 2 },
});

// Auto-DNS detection: polls dig for NS delegation for up to 45 min, heartbeating every 30 s
const { waitForDnsDelegation } = proxyActivities<typeof InfraActivities>({
  startToCloseTimeout: '50m',
  heartbeatTimeout: '90s',
  retry: { maximumAttempts: 1 }, // don't retry — timeout means "not delegated", signal still works
});

// K8s operations: context setup, manifest apply — fast but worth retrying
const { configureKubectl, applyK8sManifests } = proxyActivities<typeof K8sActivities>({
  startToCloseTimeout: '5m',
  retry: { maximumAttempts: 5, initialInterval: '5s', backoffCoefficient: 2 },
});

// Long-running K8s polls — ExternalDNS propagation, StatefulSet rollout
const { waitForExternalDNS, waitForStatefulSets } = proxyActivities<typeof K8sActivities>({
  startToCloseTimeout: '15m',
  heartbeatTimeout: '60s',
  retry: { maximumAttempts: 3, initialInterval: '10s', backoffCoefficient: 2 },
});

const { initializeCockroachDB, configureMultiRegion, setupBackupSchedule } =
  proxyActivities<typeof CrdbActivities>({
    startToCloseTimeout: '10m',
    retry: { maximumAttempts: 3, initialInterval: '10s', backoffCoefficient: 2 },
  });

const { generateAndDistributeCerts, installESO, pushSecretsToSecretManager } =
  proxyActivities<typeof CertsActivities>({
    startToCloseTimeout: '10m',
    retry: { maximumAttempts: 3, initialInterval: '10s', backoffCoefficient: 2 },
  });

// Local activity: runs on the worker directly (bypasses task queue scheduling).
// Used by the validate-dns update handler so it can do I/O (dig) and return a result.
const { checkDnsZones } = proxyLocalActivities<typeof InfraActivities>({
  startToCloseTimeout: '30s',
});

// ─── Workflow ─────────────────────────────────────────────────────────────────

export async function deployMultiRegionCRDB(params: DeployParams): Promise<void> {
  let currentPhase = Phase.BUILD;
  let dnsConfigured = false;
  // Populated once regional infra is up — returned by the nameservers query
  const nameservers: string[] = [];

  setHandler(currentPhaseQuery, () => currentPhase);
  setHandler(nameserversQuery, () => nameservers);

  // Manual override: operator sends this after configuring NS records at the registrar.
  setHandler(dnsConfiguredSignal, () => {
    dnsConfigured = true;
  });

  // Update: bidirectional dig check — returns which zones are/aren't delegated.
  // Runs checkDnsZones as a local activity so it can execute dig outside the sandbox.
  setHandler(validateDnsUpdate, async () => checkDnsZones(params.crdbDomain));

  // ── Phase 1: Build all 7 YAML output files ───────────────────────────────
  await buildStacks(params);
  currentPhase = Phase.APPLY_SHARED_INFRA;

  // ── Phase 2: Shared GCP infra (VPC, subnets, NAT, private DNS zone) ──────
  await applySharedInfra(params);
  currentPhase = Phase.APPLY_REGIONAL_INFRA;

  // ── Phase 3: Regional infra — parallel across all 3 regions ──────────────
  // Config Connector creates GKE clusters in GCP. Each applyRegionalInfra call
  // heartbeats every ~15 s while polling for GKE Ready status (~10-15 min).
  await Promise.all([
    applyRegionalInfra(params, 'east'),
    applyRegionalInfra(params, 'central'),
    applyRegionalInfra(params, 'west'),
  ]);

  // ── Fetch nameservers for the DNS delegation gate ─────────────────────────
  // Populate the nameservers query so operators can run:
  //   npm run temporal:query -- nameservers
  // to get the NS records to add at their registrar.
  const ns = await fetchNameservers(params);
  ns.forEach((n) => nameservers.push(n));

  // ── DNS delegation gate ───────────────────────────────────────────────────
  // Auto-detection: waitForDnsDelegation polls `dig +short NS` every 30 s.
  // If NS records appear within 45 min, dnsConfigured is set automatically.
  // Manual override: operator can also send the 'dns-configured' signal at any
  // time (useful if dig isn't installed on the worker host or propagation is slow).
  // Whichever path fires first unblocks the workflow.
  currentPhase = Phase.WAIT_DNS_DELEGATION;
  void waitForDnsDelegation(params).then(() => {
    dnsConfigured = true;
  }).catch(() => {
    // Auto-detection timed out or failed — workflow still waits for the manual signal
    console.log('Auto-DNS detection did not confirm delegation — waiting for manual dns-configured signal');
  });
  await condition(() => dnsConfigured, '48h');

  // ── Phase 4: kubectl credentials for the 3 workload clusters ─────────────
  currentPhase = Phase.CONFIGURE_KUBECTL;
  await configureKubectl(params);

  // ── Phase 5: TLS certificates (Docker-based, distributed to K8s Secrets) ─
  currentPhase = Phase.GENERATE_CERTS;
  await generateAndDistributeCerts(params);

  // ── Phase 6: External Secrets Operator — parallel install ─────────────────
  currentPhase = Phase.INSTALL_ESO;
  await Promise.all([
    installESO(params, 'east'),
    installESO(params, 'central'),
    installESO(params, 'west'),
  ]);

  // ── Phase 7: Push TLS certs to GCP Secret Manager ────────────────────────
  // ESO ExternalSecret resources will sync these into K8s Secrets automatically.
  currentPhase = Phase.PUSH_SECRETS;
  await pushSecretsToSecretManager(params);

  // ── Phase 8: Apply K8s manifests — parallel ───────────────────────────────
  // StatefulSets, Services, ExternalDNS, BackendConfig, monitoring, etc.
  currentPhase = Phase.APPLY_K8S;
  await Promise.all([
    applyK8sManifests(params, 'east'),
    applyK8sManifests(params, 'central'),
    applyK8sManifests(params, 'west'),
  ]);

  // ── Phase 9: Wait for ExternalDNS to register pod IPs ─────────────────────
  // Heartbeats while polling gcloud dns record-sets list for A records.
  currentPhase = Phase.WAIT_DNS_RECORDS;
  await waitForExternalDNS(params);

  // ── Phase 10: Wait for all 9 CockroachDB pods Running — parallel ──────────
  // Each region's StatefulSet rollout is independent; run them concurrently.
  currentPhase = Phase.WAIT_STATEFULSETS;
  await Promise.all([
    waitForStatefulSets(params, 'east'),
    waitForStatefulSets(params, 'central'),
    waitForStatefulSets(params, 'west'),
  ]);

  // ── Phase 11: cockroach init ───────────────────────────────────────────────
  currentPhase = Phase.INIT_CRDB;
  await initializeCockroachDB(params);

  // ── Phase 12: Multi-region topology (SURVIVE REGION FAILURE) ──────────────
  currentPhase = Phase.CONFIGURE_REGIONS;
  await configureMultiRegion(params);

  // ── Phase 13: Daily GCS backup schedule ───────────────────────────────────
  currentPhase = Phase.SETUP_BACKUP;
  await setupBackupSchedule(params);

  currentPhase = Phase.COMPLETE;
}
