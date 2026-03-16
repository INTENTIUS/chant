import { exec } from 'child_process';
import { promisify } from 'util';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { Context } from '@temporalio/activity';
import type { DeployParams, Region } from '../types.js';
import { REGION_CONFIG } from '../types.js';

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));
// temporal/activities/ → go up 2 levels to the example root
const ROOT_DIR = resolve(__dirname, '../..');

function env(params: DeployParams): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GCP_PROJECT_ID: params.gcpProjectId,
    CRDB_DOMAIN: params.crdbDomain,
  };
}

export async function buildStacks(params: DeployParams): Promise<void> {
  const { stdout, stderr } = await execAsync('npm run build', {
    cwd: ROOT_DIR,
    env: env(params),
  });
  if (stdout) console.log(stdout.trim());
  if (stderr) console.error(stderr.trim());
}

export async function applySharedInfra(params: DeployParams): Promise<void> {
  const { stdout } = await execAsync('kubectl apply -f dist/shared-infra.yaml', {
    cwd: ROOT_DIR,
    env: env(params),
  });
  console.log(stdout.trim());
}

/**
 * Applies regional GCP infra and waits for the GKE cluster to become Ready.
 *
 * This activity heartbeats every ~15 s so Temporal knows it's still alive
 * during the ~10-15 min Config Connector reconciliation window.
 */
export async function applyRegionalInfra(params: DeployParams, region: Region): Promise<void> {
  const ctx = Context.current();
  const { gkeCluster, gkeRegion } = REGION_CONFIG[region];

  ctx.heartbeat({ phase: 'applying infra yaml', region });
  const { stdout } = await execAsync(`kubectl apply -f dist/${region}-infra.yaml`, {
    cwd: ROOT_DIR,
    env: env(params),
  });
  console.log(stdout.trim());

  // Poll until Config Connector marks the GKE cluster Ready (~10-15 min)
  for (let attempt = 1; attempt <= 60; attempt++) {
    ctx.heartbeat({ phase: 'waiting for GKE Ready', region, attempt });

    const { stdout: status } = await execAsync(
      `kubectl get containercluster ${gkeCluster} -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}'`,
      { cwd: ROOT_DIR, env: env(params) },
    ).catch(() => ({ stdout: '' }));

    if (status.trim() === 'True') {
      console.log(`${gkeCluster}: Ready`);
      break;
    }

    console.log(`${gkeCluster}: not Ready yet (${attempt}/60)`);
    if (attempt === 60) throw new Error(`${gkeCluster} not Ready after 15 minutes`);
    await sleep(15_000);
  }

  // Wait for the managed node pool before deleting the default pool
  for (let attempt = 1; attempt <= 60; attempt++) {
    ctx.heartbeat({ phase: 'waiting for node pool RUNNING', region, attempt });

    const { stdout: poolStatus } = await execAsync(
      `gcloud container node-pools describe ${gkeCluster}-nodes` +
        ` --cluster ${gkeCluster} --region ${gkeRegion}` +
        ` --project ${params.gcpProjectId} --format='value(status)'`,
      { cwd: ROOT_DIR, env: env(params) },
    ).catch(() => ({ stdout: '' }));

    if (poolStatus.trim() === 'RUNNING') {
      console.log(`${gkeCluster}-nodes: RUNNING`);
      break;
    }

    console.log(`${gkeCluster}-nodes: ${poolStatus.trim() || 'not found'} (${attempt}/60)`);
    if (attempt === 60) throw new Error(`${gkeCluster}-nodes not RUNNING after 15 minutes`);
    await sleep(15_000);
  }

  ctx.heartbeat({ phase: 'deleting default-pool', region });
  await execAsync(
    `gcloud container node-pools delete default-pool` +
      ` --cluster ${gkeCluster} --region ${gkeRegion}` +
      ` --project ${params.gcpProjectId} --quiet`,
    { cwd: ROOT_DIR, env: env(params) },
  ).catch(() => {}); // idempotent — pool may already be gone
}

/**
 * Fetches the Cloud DNS nameservers for the three public zones created during
 * regional infra apply. Returns strings formatted for the nameservers query.
 */
export async function fetchNameservers(params: DeployParams): Promise<string[]> {
  const zones = [
    { zone: 'crdb-east-zone',    subdomain: 'east.crdb' },
    { zone: 'crdb-central-zone', subdomain: 'central.crdb' },
    { zone: 'crdb-west-zone',    subdomain: 'west.crdb' },
  ];

  const results: string[] = [];
  for (const { zone, subdomain } of zones) {
    const { stdout } = await execAsync(
      `gcloud dns managed-zones describe ${zone} --project ${params.gcpProjectId}` +
        ` --format='value(nameServers)'`,
      { cwd: ROOT_DIR, env: env(params) },
    ).catch(() => ({ stdout: '' }));

    const servers = stdout.trim().split(';').filter(Boolean);
    if (servers.length > 0) {
      results.push(`${subdomain}.${params.crdbDomain}: ${servers.join(', ')}`);
    }
  }
  return results;
}

/**
 * Polls public DNS for NS delegation on all three CRDB subdomains.
 * Heartbeats every 30 s so the heartbeatTimeout is never exceeded.
 * Used by the workflow as an auto-detect alternative to the manual dns-configured signal.
 */
export async function waitForDnsDelegation(params: DeployParams): Promise<void> {
  const ctx = Context.current();
  const subdomains = ['east', 'central', 'west'];
  const maxAttempts = 90; // 90 × 30 s = 45 min

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    ctx.heartbeat({ phase: 'waiting for DNS delegation', attempt });

    const missing: string[] = [];
    for (const sub of subdomains) {
      const { stdout } = await execAsync(
        `dig +short NS ${sub}.crdb.${params.crdbDomain}`,
        { cwd: ROOT_DIR, env: env(params) },
      ).catch(() => ({ stdout: '' }));
      if (!stdout.trim()) missing.push(sub);
    }

    if (missing.length === 0) {
      console.log('DNS delegation confirmed for all zones');
      return;
    }

    console.log(`DNS delegation pending for: ${missing.join(', ')} (attempt ${attempt}/${maxAttempts})`);
    if (attempt === maxAttempts) {
      throw new Error(`DNS delegation not detected after 45 min — pending zones: ${missing.join(', ')}`);
    }
    await sleep(30_000);
  }
}

/**
 * Checks current NS delegation status for all three CRDB zones.
 * Used by the validate-dns update handler (runs as a local activity).
 */
export async function checkDnsZones(crdbDomain: string): Promise<{ ready: boolean; missing: string[] }> {
  const subdomains = ['east', 'central', 'west'];
  const missing: string[] = [];

  for (const sub of subdomains) {
    const { stdout } = await execAsync(
      `dig +short NS ${sub}.crdb.${crdbDomain}`,
    ).catch(() => ({ stdout: '' }));
    if (!stdout.trim()) missing.push(sub);
  }

  return { ready: missing.length === 0, missing };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
