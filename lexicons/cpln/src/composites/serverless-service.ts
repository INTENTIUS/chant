/**
 * ServerlessService — a serverless workload with the port, probe and firewall
 * settings a public HTTP service actually needs.
 *
 * Serverless is the Control Plane workload type with the most rules attached to
 * it, and most of them are easy to get wrong by omission rather than by writing
 * something incorrect:
 *
 * - It must expose *exactly one* HTTP port. Zero or two is rejected.
 * - The external firewall's inbound is closed by default, so a workload that
 *   looks completely correct serves nothing until a CIDR is added.
 * - `concurrency` and `rps` are the only strategies that scale to zero, and
 *   only on this workload type.
 *
 * The defaults here are Control Plane's own, restated so they are visible at
 * the call site rather than implied.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { Workload } from "../generated";

export interface ServerlessServiceProps {
  /** Workload name. Max 49 characters, and cannot end with `-headless`. */
  name: string;
  /** GVC this workload is deployed into. */
  gvc: string;
  /** Container image. Use `//image/NAME:TAG` for the org's own registry. */
  image: string;
  /**
   * The port the container listens on. Serverless exposes exactly one HTTP
   * port, and it must match what the process actually binds or health checks
   * fail.
   */
  port?: number;
  /** Protocol for the exposed port (default `http`). */
  protocol?: "http" | "http2";
  /** Container name (default `main`). */
  containerName?: string;
  /** CPU in millicores (default `50m`). Minimum 25m. */
  cpu?: string;
  /** Memory (default `128Mi`). Minimum 32Mi, and memory(MiB)/cpu(m) must be ≤ 8. */
  memory?: string;
  /** Environment variables, as a plain map. */
  env?: Record<string, string>;
  /**
   * CIDRs allowed to reach the workload from the internet. Defaults to closed;
   * pass `["0.0.0.0/0"]` for a public service.
   */
  inboundAllowCidr?: string[];
  /** Hostnames or CIDRs the workload may call out to. Defaults to closed. */
  outboundAllowCidr?: string[];
  /** Minimum replicas (default 1). `0` scales to zero. */
  minScale?: number;
  /** Maximum replicas (default 5). */
  maxScale?: number;
  /**
   * Autoscaling strategy (default `concurrency`). Only `concurrency` and `rps`
   * scale a serverless workload to zero; `cpu`/`memory` cannot, and `latency`
   * and multi-metric are not available on serverless at all.
   */
  autoscalingMetric?: "concurrency" | "rps" | "cpu" | "memory" | "disabled";
  /** Scaling target (default 95). Capped at 100 for cpu/memory. */
  autoscalingTarget?: number;
  /**
   * Identity to run as, as a link (`//gvc/GVC/identity/NAME`). Leave unset
   * unless the workload needs secret access, credential-free cloud access or
   * private networking — an unnecessary identity assignment complicates audit
   * traces.
   */
  identityLink?: string;
  /** Tags applied to the workload. */
  tags?: Record<string, string>;
  /** Per-member defaults for customizing the underlying resource. */
  defaults?: {
    workload?: Partial<ConstructorParameters<typeof Workload>[0]>;
  };
}

export const ServerlessService = Composite((props: ServerlessServiceProps) => {
  const {
    name,
    gvc,
    image,
    port = 8080,
    protocol = "http",
    containerName = "main",
    cpu = "50m",
    memory = "128Mi",
    env,
    inboundAllowCidr = [],
    outboundAllowCidr = [],
    minScale = 1,
    maxScale = 5,
    autoscalingMetric = "concurrency",
    autoscalingTarget = 95,
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
          type: "serverless",
          ...(identityLink && { identityLink }),
          containers: [
            {
              name: containerName,
              image,
              cpu,
              memory,
              ports: [{ number: port, protocol }],
              ...(env && {
                env: Object.entries(env).map(([envName, value]) => ({ name: envName, value })),
              }),
            },
          ],
          firewallConfig: {
            external: {
              inboundAllowCIDR: inboundAllowCidr,
              outboundAllowCIDR: outboundAllowCidr,
            },
          },
          defaultOptions: {
            autoscaling: {
              metric: autoscalingMetric,
              target: autoscalingTarget,
              minScale,
              maxScale,
            },
          },
        },
      } as Record<string, unknown>,
      defs?.workload,
    ),
  );

  return { workload };
}, "ServerlessService");
