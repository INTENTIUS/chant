/**
 * wait / verify family, azure members (#3142): `wait-for-deployment` (every
 * resource of a group reaches an ARM terminal provisioning state) and
 * `wait-container-app` (a Container App serves its latest revision). Both
 * poll ARM through the read client, so a test or floci-az swaps `http`. A wait
 * is a read-only observation: neither declares a rollback.
 */
import type { Capability } from "@intentius/chant/components/capability";
import { getResource, getResourceById, isNotFound, listResources, type AzureReadClientOptions } from "../api/read-client";
import type { AzHttp } from "../op/activities/az-apply";

const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
/** ARM provisioning states that will not change without a new request. */
const TERMINAL = new Set(["Succeeded", "Failed", "Canceled"]);

export interface AzureWaitOptions {
  http?: AzHttp;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface TargetInput {
  /** The resource group. Default: the component's name. */
  resourceGroup?: string;
  /** ARM endpoint. Default: `AZURE_ENDPOINT_URL`, else real Azure. */
  endpoint?: string;
  /** Subscription id. Default: `AZURE_SUBSCRIPTION_ID`, else floci-az's local subscription. */
  subscriptionId?: string;
  /** Poll interval in ms. Default: 10000. */
  intervalMs?: number;
  /** Overall timeout in ms. Default: 10 minutes. */
  timeoutMs?: number;
}

function client(input: TargetInput, component: string, options: AzureWaitOptions): AzureReadClientOptions {
  const endpoint = input.endpoint ?? process.env.AZURE_ENDPOINT_URL;
  const subscriptionId = input.subscriptionId ?? process.env.AZURE_SUBSCRIPTION_ID;
  return {
    resourceGroup: input.resourceGroup ?? component,
    ...(endpoint ? { endpoint } : {}),
    ...(subscriptionId ? { subscriptionId } : {}),
    ...(options.http ? { http: options.http } : {}),
  };
}

function provisioningState(body: { properties?: Record<string, unknown> }): string | undefined {
  const s = body.properties?.provisioningState;
  return typeof s === "string" ? s : undefined;
}

// ── wait-for-deployment ──────────────────────────────────────────────────────

export type WaitForDeploymentInput = TargetInput;

export interface WaitForDeploymentOutput {
  /** Resources of the group, each with the state it ended in. */
  resources: Array<{ type: string; name: string; state: string }>;
}

/**
 * Poll the group until no resource is still provisioning. Throws when one ends
 * `Failed` or `Canceled`, or when the timeout passes first. A resource whose
 * body carries no `provisioningState` (some types do not) counts as settled.
 */
export function createWaitForDeploymentCapability(
  options: AzureWaitOptions = {},
): Capability<WaitForDeploymentInput, WaitForDeploymentOutput> {
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;
  return {
    kind: "wait-for-deployment",
    async run(ctx, input) {
      const read = client(input, ctx.component, options);
      const interval = input.intervalMs ?? DEFAULT_INTERVAL_MS;
      const deadline = now() + (input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      while (true) {
        const listed = await listResources(read);
        const resources: WaitForDeploymentOutput["resources"] = [];
        for (const item of listed) {
          const body = item.id ? await getResourceById(read, item.id) : item;
          resources.push({
            type: String(item.type ?? ""),
            name: String(item.name ?? ""),
            state: provisioningState(body) ?? "Succeeded",
          });
        }
        const bad = resources.find((r) => r.state === "Failed" || r.state === "Canceled");
        if (bad) throw new Error(`wait-for-deployment "${read.resourceGroup}": ${bad.type}/${bad.name} ended ${bad.state}`);
        if (resources.every((r) => TERMINAL.has(r.state))) return { resources };
        if (now() > deadline) {
          const pending = resources.filter((r) => !TERMINAL.has(r.state)).map((r) => `${r.name} (${r.state})`).join(", ");
          throw new Error(`wait-for-deployment "${read.resourceGroup}" timed out; still provisioning: ${pending}`);
        }
        await sleep(interval);
      }
    },
  };
}

export const waitForDeploymentCapability: Capability<WaitForDeploymentInput, WaitForDeploymentOutput> =
  createWaitForDeploymentCapability();

// ── wait-container-app ───────────────────────────────────────────────────────

export interface WaitContainerAppInput extends TargetInput {
  /** The Container App's name. */
  app: string;
}

export interface WaitContainerAppOutput {
  /** The revision serving traffic once the app is steady. */
  revision: string;
  /** The app's FQDN, when it has ingress. */
  fqdn?: string;
}

/**
 * Poll a Container App until provisioning succeeded and its latest revision is
 * the latest ready one. A rollout that fails provisioning throws.
 */
export function createWaitContainerAppCapability(
  options: AzureWaitOptions = {},
): Capability<WaitContainerAppInput, WaitContainerAppOutput> {
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;
  return {
    kind: "wait-container-app",
    async run(ctx, input) {
      const read = client(input, ctx.component, options);
      const interval = input.intervalMs ?? DEFAULT_INTERVAL_MS;
      const deadline = now() + (input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      while (true) {
        let state = "NotFound";
        let ready = false;
        let revision = "";
        let fqdn: string | undefined;
        try {
          const body = await getResource(read, "Microsoft.App/containerApps", input.app);
          const props = body.properties ?? {};
          state = provisioningState(body) ?? "Unknown";
          const latest = typeof props.latestRevisionName === "string" ? props.latestRevisionName : undefined;
          const latestReady = typeof props.latestReadyRevisionName === "string" ? props.latestReadyRevisionName : undefined;
          revision = latestReady ?? latest ?? "";
          ready = state === "Succeeded" && (latest === undefined || latest === latestReady);
          const ingress = (props.configuration as { ingress?: { fqdn?: unknown } } | undefined)?.ingress;
          if (typeof ingress?.fqdn === "string") fqdn = ingress.fqdn;
        } catch (err) {
          if (!isNotFound(err)) throw err;
        }
        if (state === "Failed" || state === "Canceled") throw new Error(`wait-container-app "${input.app}" ended ${state}`);
        if (ready) return { revision, ...(fqdn ? { fqdn } : {}) };
        if (now() > deadline) throw new Error(`wait-container-app "${input.app}" timed out in state ${state}`);
        await sleep(interval);
      }
    },
  };
}

export const waitContainerAppCapability: Capability<WaitContainerAppInput, WaitContainerAppOutput> =
  createWaitContainerAppCapability();
