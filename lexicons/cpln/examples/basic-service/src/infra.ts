/**
 * A GVC and one public serverless service.
 *
 * The smallest thing worth deploying on Control Plane, written the way the
 * platform's own rules push you to: placement on the GVC, exactly one HTTP
 * port on the workload, and the firewall opened explicitly because it starts
 * closed in both directions.
 */

import { GvcEnvironment, ServerlessService } from "@intentius/chant-lexicon-cpln";

const org = process.env.CPLN_ORG ?? "acme";

export const { gvc } = GvcEnvironment({
  name: "prod",
  org,
  // Placement is a GVC-level decision. A GVC with no locations accepts
  // workloads and schedules them nowhere (CPL042).
  locations: ["aws-us-east-1"],
  tags: { team: "platform" },
});

export const { workload } = ServerlessService({
  name: "web",
  gvc: "prod",
  // Pinned rather than :latest — a scale-from-zero cold start re-pulls, so an
  // unpinned tag means two replicas of one deploy can differ (CPL040).
  image: "nginx:1.27",
  port: 8080,
  cpu: "50m",
  memory: "128Mi",
  // Open to the internet, said out loud. Egress stays closed.
  inboundAllowCidr: ["0.0.0.0/0"],
  minScale: 0,
  maxScale: 10,
  // `concurrency` is one of the two strategies that actually scale a
  // serverless workload to zero (CPL026).
  autoscalingMetric: "concurrency",
  env: { LOG_LEVEL: "info" },
  tags: { team: "platform" },
});
