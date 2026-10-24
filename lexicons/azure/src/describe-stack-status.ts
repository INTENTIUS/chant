/**
 * Deploy-unit status for Azure (#3142, the #1495 seam). An `arm-deploy` unit is
 * its resource group. It is present when the group holds chant-owned
 * resources (the ownership tags `arm-deploy` stamps), and healthy when every
 * one of them reports a `Succeeded` provisioning state. A read that cannot
 * happen (no credentials, ARM unreachable) is indeterminate (`null`), never a
 * confident absence; a group ARM says does not exist is `present: false`.
 */
import type { StackStatusObservation } from "@intentius/chant/lexicon";
import { getResourceById, isNotFound, listResources, type AzureReadClientOptions } from "./api/read-client";
import { isChantOwned } from "./op/activities/az-apply";

export async function describeStackStatus(
  options: { environment: string; stack: string },
  read: Partial<AzureReadClientOptions> = {},
): Promise<StackStatusObservation | null> {
  const client: AzureReadClientOptions = {
    ...(process.env.AZURE_ENDPOINT_URL ? { endpoint: process.env.AZURE_ENDPOINT_URL } : {}),
    ...(process.env.AZURE_SUBSCRIPTION_ID ? { subscriptionId: process.env.AZURE_SUBSCRIPTION_ID } : {}),
    ...read,
    resourceGroup: options.stack,
  };
  try {
    const owned = (await listResources(client)).filter((r) => isChantOwned(r.tags));
    if (owned.length === 0) return { stack: options.stack, present: false };
    const states: string[] = [];
    for (const item of owned) {
      const body = item.id ? await getResourceById(client, item.id) : item;
      const s = body.properties?.provisioningState;
      states.push(typeof s === "string" ? s : "Succeeded");
    }
    const ok = states.filter((s) => s === "Succeeded").length;
    return {
      stack: options.stack,
      present: true,
      status: `${ok}/${states.length} resources succeeded`,
      healthy: ok === states.length,
    };
  } catch (err) {
    if (isNotFound(err)) return { stack: options.stack, present: false };
    return null;
  }
}
