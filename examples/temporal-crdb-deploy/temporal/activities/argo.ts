/**
 * Argo activities — the bridge between Temporal orchestration and Argo CD's
 * reconciliation layer.
 *
 * `applyArgoApps` bootstraps the Argo Applications/ApplicationSet/cluster Secrets
 * (authored in src/argo via ArgoAppFor / ArgoAppSetForRegions / registerArgoCluster)
 * onto the management cluster's Argo CD. After that, Argo owns the apply loop and
 * the workflow only *waits* — `waitForArgoSync` polls each Application until it is
 * Healthy + Synced, replacing the old hand-written apply + StatefulSet-rollout
 * activities.
 */
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { Context } from '@temporalio/activity';
import {
  waitForArgoSync as _waitForArgoSync,
  type WaitForArgoSyncArgs,
  type ArgoAppStatus,
} from '@intentius/chant-lexicon-temporal/op/activities';
import type { DeployParams } from '../types.js';

const execAsync = promisify(exec);

/**
 * Apply the infra-layer Argo Applications (built to dist/argo-infra.yaml) to the
 * management cluster's Argo CD. These reconcile the Config Connector resources
 * that create the regional GKE clusters. Idempotent.
 */
export async function applyArgoInfra(_params: DeployParams): Promise<void> {
  await execAsync('kubectl apply -f dist/argo-infra.yaml', { cwd: process.cwd() });
}

/**
 * Apply the workload-layer Argo manifests (built to dist/argo-workload.yaml):
 * the workload-cluster registration Secrets plus the ESO (Helm) and CockroachDB
 * Applications that target them. Must run after the regional GKE clusters exist
 * and kubectl credentials are available — the cluster Secrets carry endpoints
 * that don't exist until SYNC_INFRA completes. Idempotent.
 */
export async function applyArgoWorkload(_params: DeployParams): Promise<void> {
  await execAsync('kubectl apply -f dist/argo-workload.yaml', { cwd: process.cwd() });
}

/**
 * Wait until an Argo Application is Healthy + Synced. Wraps the dependency-free
 * lexicon activity, threading Temporal's cancellation signal through so the
 * activity stops promptly on workflow cancellation. Uses the kubectl reader
 * against the management cluster (the Application objects live in `argocd`).
 */
export async function waitForArgoSync(args: WaitForArgoSyncArgs): Promise<ArgoAppStatus> {
  return _waitForArgoSync(args, Context.current().cancellationSignal);
}
