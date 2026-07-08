import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const DEFAULT_LOCATION = "eastus";

export interface AzGroupEnsureArgs {
  /** Resource group name — the same value passed as `env` to a `arm` `nativeApply`. */
  resourceGroup: string;
  /** Azure region for the group. Default: `eastus`. */
  location?: string;
}

export interface AzGroupDeleteArgs {
  /** Resource group to delete. */
  resourceGroup: string;
}

/**
 * Build the `az group create` command. `az group create` is idempotent — a group
 * that already exists is returned unchanged — so no existence check is needed.
 * Pure — exported for testing.
 */
export function azGroupEnsureCommand(resourceGroup: string, location: string): string {
  return `az group create --name ${resourceGroup} --location ${location} --output none`;
}

/** Build the `az group delete` command (non-blocking). Pure — exported for testing. */
export function azGroupDeleteCommand(resourceGroup: string): string {
  return `az group delete --name ${resourceGroup} --yes --no-wait`;
}

/**
 * Ensure an Azure resource group exists before an ARM deployment.
 *
 * `az deployment group create` (the `arm` target of `nativeApply`) fails if its
 * resource group is absent — unlike CloudFormation, which creates its own stack.
 * Run this before the apply. Uses fastIdempotent profile — 5m timeout.
 *
 * This targets real Azure (via the logged-in `az` context). Local emulation
 * against floci-az awaits an upstream `Microsoft.Resources/deployments` provider
 * (see #705); when that lands, an endpoint/custom-cloud override slots in here.
 */
export async function azGroupEnsure(args: AzGroupEnsureArgs, signal?: AbortSignal): Promise<void> {
  const location = args.location ?? DEFAULT_LOCATION;
  const { stdout, stderr } = await execAsync(
    azGroupEnsureCommand(args.resourceGroup, location),
    { signal },
  );
  if (stdout) console.log(stdout);
  if (stderr) console.error(stderr);
}

/**
 * Delete an Azure resource group and everything in it (non-blocking). A no-op
 * success when the group is already gone. Uses fastIdempotent profile — 5m
 * timeout (`--no-wait` returns immediately).
 */
export async function azGroupDelete(args: AzGroupDeleteArgs, signal?: AbortSignal): Promise<void> {
  try {
    await execAsync(azGroupDeleteCommand(args.resourceGroup), { signal });
  } catch {
    // Group already absent — treat as success.
  }
}
