/**
 * Temporal client CLI — start, signal, query, and update the deploy workflow.
 *
 * Usage (via npm scripts):
 *   npm run temporal:deploy                    # start the workflow
 *   npm run temporal:query -- current-phase    # query current phase
 *   npm run temporal:query -- nameservers      # get DNS nameservers
 *   npm run temporal:signal -- dns-configured  # unblock DNS delegation step (manual override)
 *   npm run temporal:update -- validate-dns    # check DNS delegation status (returns result)
 *
 * Required env vars: TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, TEMPORAL_API_KEY
 * Also reads: GCP_PROJECT_ID, CRDB_DOMAIN
 *
 * Search attributes (register once in Temporal Cloud UI before first run):
 *   Settings → Search Attributes → Add: GcpProject (Text), CrdbDomain (Text)
 */
import { Client, Connection } from '@temporalio/client';
import {
  deployMultiRegionCRDB,
  currentPhaseQuery,
  nameserversQuery,
  dnsConfiguredSignal,
  validateDnsUpdate,
} from './workflows/deploy.js';
import type { DeployParams } from './types.js';

async function makeClient(): Promise<Client> {
  const address = process.env.TEMPORAL_ADDRESS;
  const namespace = process.env.TEMPORAL_NAMESPACE;
  const apiKey = process.env.TEMPORAL_API_KEY;

  if (!address || !namespace || !apiKey) {
    console.error(
      'Missing required env vars: TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, TEMPORAL_API_KEY',
    );
    process.exit(1);
  }

  const connection = await Connection.connect({
    address,
    tls: {},
    metadata: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  return new Client({ connection, namespace });
}

function workflowId(gcpProjectId: string): string {
  // Deterministic ID: re-running with the same project ID won't start a second
  // workflow if one is already running — Temporal deduplicates by workflow ID.
  return `crdb-deploy-${gcpProjectId}`;
}

async function start(): Promise<void> {
  const gcpProjectId = process.env.GCP_PROJECT_ID;
  const crdbDomain = process.env.CRDB_DOMAIN;

  if (!gcpProjectId || !crdbDomain) {
    console.error('Missing required env vars: GCP_PROJECT_ID, CRDB_DOMAIN');
    process.exit(1);
  }

  const params: DeployParams = { gcpProjectId, crdbDomain };
  const id = workflowId(gcpProjectId);
  const client = await makeClient();

  const handle = await client.workflow.start(deployMultiRegionCRDB, {
    taskQueue: 'crdb-deploy',
    workflowId: id,
    args: [params],
    // Tag each deployment with project + domain so you can filter in the
    // Temporal Cloud UI: GcpProject = "my-project" or CrdbDomain = "example.com"
    // Requires custom search attributes registered in Temporal Cloud Settings.
    searchAttributes: {
      GcpProject: [gcpProjectId],
      CrdbDomain: [crdbDomain],
    },
  });

  console.log(`Workflow started: ${handle.workflowId}`);
  console.log(`View in Temporal Cloud UI: https://cloud.temporal.io`);
  console.log(`\nRun to check progress:`);
  console.log(`  npm run temporal:query -- current-phase`);
}

async function signal(signalName: string): Promise<void> {
  const gcpProjectId = process.env.GCP_PROJECT_ID;
  if (!gcpProjectId) {
    console.error('Missing env var: GCP_PROJECT_ID');
    process.exit(1);
  }

  const client = await makeClient();
  const handle = client.workflow.getHandle(workflowId(gcpProjectId));

  if (signalName === 'dns-configured') {
    await handle.signal(dnsConfiguredSignal);
    console.log('Signal sent: dns-configured');
    console.log('Workflow will now proceed to configure kubectl and generate certs.');
  } else {
    console.error(`Unknown signal: ${signalName}`);
    console.error('Available signals: dns-configured');
    process.exit(1);
  }
}

async function query(queryName: string): Promise<void> {
  const gcpProjectId = process.env.GCP_PROJECT_ID;
  if (!gcpProjectId) {
    console.error('Missing env var: GCP_PROJECT_ID');
    process.exit(1);
  }

  const client = await makeClient();
  const handle = client.workflow.getHandle(workflowId(gcpProjectId));

  if (queryName === 'current-phase') {
    const phase = await handle.query(currentPhaseQuery);
    console.log(`Current phase: ${phase}`);
  } else if (queryName === 'nameservers') {
    const ns = await handle.query(nameserversQuery);
    if (ns.length === 0) {
      console.log('Nameservers not yet available (regional infra still deploying)');
    } else {
      console.log('DNS nameservers:');
      ns.forEach((n) => console.log(`  ${n}`));
      console.log('\nAdd NS records at your registrar, then run:');
      console.log('  npm run temporal:update -- validate-dns   # confirm propagation');
      console.log('  npm run temporal:signal -- dns-configured  # or send signal manually');
    }
  } else {
    console.error(`Unknown query: ${queryName}`);
    console.error('Available queries: current-phase, nameservers');
    process.exit(1);
  }
}

async function update(updateName: string): Promise<void> {
  const gcpProjectId = process.env.GCP_PROJECT_ID;
  if (!gcpProjectId) {
    console.error('Missing env var: GCP_PROJECT_ID');
    process.exit(1);
  }

  const client = await makeClient();
  const handle = client.workflow.getHandle(workflowId(gcpProjectId));

  if (updateName === 'validate-dns') {
    const result = await handle.executeUpdate(validateDnsUpdate);
    if (result.ready) {
      console.log('DNS delegation confirmed for all zones.');
      console.log('Run: npm run temporal:signal -- dns-configured');
    } else {
      console.log(`DNS delegation pending. Missing zones: ${result.missing.join(', ')}`);
      console.log('Wait for NS records to propagate, then retry: npm run temporal:update -- validate-dns');
    }
  } else {
    console.error(`Unknown update: ${updateName}`);
    console.error('Available updates: validate-dns');
    process.exit(1);
  }
}

// ─── CLI dispatch ─────────────────────────────────────────────────────────────
const [, , subcommand, arg] = process.argv;

switch (subcommand) {
  case 'start':
    start().catch((e) => { console.error(e); process.exit(1); });
    break;
  case 'signal':
    if (!arg) { console.error('Usage: tsx temporal/client.ts signal <signal-name>'); process.exit(1); }
    signal(arg).catch((e) => { console.error(e); process.exit(1); });
    break;
  case 'query':
    if (!arg) { console.error('Usage: tsx temporal/client.ts query <query-name>'); process.exit(1); }
    query(arg).catch((e) => { console.error(e); process.exit(1); });
    break;
  case 'update':
    if (!arg) { console.error('Usage: tsx temporal/client.ts update <update-name>'); process.exit(1); }
    update(arg).catch((e) => { console.error(e); process.exit(1); });
    break;
  default:
    console.error('Usage: tsx temporal/client.ts <start|signal|query|update> [arg]');
    process.exit(1);
}
