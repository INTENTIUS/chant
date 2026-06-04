import { exec } from 'child_process';
import { promisify } from 'util';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { Context } from '@temporalio/activity';
import type { DeployParams } from '../types.js';

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

/**
 * Fetches the Cloud DNS nameservers for the three public zones created during
 * regional infra apply (now reconciled by Argo CD — see src/argo). Returns
 * strings formatted for the nameservers query.
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
