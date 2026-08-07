/**
 * CronJob — a scheduled workload, with the constraints cron carries.
 *
 * Cron is the workload type with the most *silent* rules: it must not expose
 * any port, its container has to exit on completion, and probes, autoscaling,
 * `timeoutSeconds` and `debug` are all accepted and then ignored. Rather than
 * let a caller set those and wonder why nothing happens, this composite has no
 * knobs for them.
 *
 * A cron workload also deploys to every location in its GVC with no
 * per-location override, so placement is a property of the GVC, not of this.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { Workload } from "../generated";

export interface CronJobProps {
  /** Workload name. Max 49 characters. */
  name: string;
  /** GVC this job is deployed into. */
  gvc: string;
  /** Container image. */
  image: string;
  /** Cron schedule, standard five-field syntax (e.g. `"0 * * * *"`). */
  schedule: string;
  /** Container name (default `main`). */
  containerName?: string;
  /** Entrypoint override. */
  command?: string;
  /** Arguments passed to the entrypoint. */
  args?: string[];
  /** CPU in millicores (default `50m`). */
  cpu?: string;
  /** Memory (default `128Mi`). */
  memory?: string;
  /** Environment variables, as a plain map. */
  env?: Record<string, string>;
  /**
   * What to do when a run is still going at the next scheduled time
   * (default `Forbid` — skip the new run rather than overlap).
   */
  concurrencyPolicy?: "Allow" | "Forbid" | "Replace";
  /** Restart behaviour for a failed run (default `Never`). */
  restartPolicy?: "Never" | "OnFailure";
  /** Seconds a run may take before it is killed. */
  activeDeadlineSeconds?: number;
  /** How many finished runs to retain. */
  historyLimit?: number;
  /** Hostnames or CIDRs the job may call out to. Defaults to closed. */
  outboundAllowCidr?: string[];
  /** Identity to run as, as a link (`//gvc/GVC/identity/NAME`). */
  identityLink?: string;
  /** Tags applied to the workload. */
  tags?: Record<string, string>;
  /** Per-member defaults for customizing the underlying resource. */
  defaults?: {
    workload?: Partial<ConstructorParameters<typeof Workload>[0]>;
  };
}

export const CronJob = Composite((props: CronJobProps) => {
  const {
    name,
    gvc,
    image,
    schedule,
    containerName = "main",
    command,
    args,
    cpu = "50m",
    memory = "128Mi",
    env,
    concurrencyPolicy = "Forbid",
    restartPolicy = "Never",
    activeDeadlineSeconds,
    historyLimit,
    outboundAllowCidr = [],
    identityLink,
    tags,
    defaults: defs,
  } = props;

  const workload = new Workload(
    mergeDefaults(
      {
        name,
        gvc,
        ...(tags && { tags }),
        spec: {
          type: "cron",
          ...(identityLink && { identityLink }),
          job: {
            schedule,
            concurrencyPolicy,
            restartPolicy,
            ...(activeDeadlineSeconds !== undefined && { activeDeadlineSeconds }),
            ...(historyLimit !== undefined && { historyLimit }),
          },
          containers: [
            {
              name: containerName,
              image,
              cpu,
              memory,
              ...(command && { command }),
              ...(args && { args }),
              ...(env && {
                env: Object.entries(env).map(([envName, value]) => ({ name: envName, value })),
              }),
            },
          ],
          firewallConfig: {
            // A cron job serves nothing, so inbound stays closed. Outbound is
            // the only direction worth opening.
            external: { inboundAllowCIDR: [], outboundAllowCIDR: outboundAllowCidr },
          },
        },
      } as Record<string, unknown>,
      defs?.workload,
    ),
  );

  return { workload };
}, "CronJob");
