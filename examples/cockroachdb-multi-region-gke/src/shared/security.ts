// Cloud Armor WAF policy for CockroachDB UI protection.
// Shared across all 3 regions — referenced by BackendConfig in each cluster.

import { createResource } from "@intentius/chant/runtime";

const ComputeSecurityPolicy = createResource("GCP::Compute::SecurityPolicy", "gcp", {});

export const wafPolicy = new ComputeSecurityPolicy({
  metadata: {
    name: "crdb-ui-waf",
    labels: { "app.kubernetes.io/managed-by": "chant" },
  },
  adaptiveProtectionConfig: {
    layer7DdosDefenseConfig: { enable: true },
  },
  rule: [
    {
      action: "rate_based_ban",
      priority: 1000,
      match: { versionedExpr: "SRC_IPS_V1", config: { srcIpRanges: ["*"] } },
      rateLimitOptions: {
        conformAction: "allow",
        exceedAction: "deny(429)",
        rateLimitThreshold: { count: 3000, intervalSec: 60 },
        banDurationSec: 60,
      },
      description: "Rate limit: 3000 req/min per IP, 1-min ban",
    },
    {
      action: "deny(403)",
      priority: 2000,
      match: { expr: { expression: "evaluatePreconfiguredWaf('xss-v33-stable')" } },
      description: "Block XSS attacks",
    },
    {
      action: "deny(403)",
      priority: 2001,
      match: { expr: { expression: "evaluatePreconfiguredWaf('sqli-v33-stable')" } },
      description: "Block SQL injection attacks",
    },
    {
      action: "allow",
      priority: 2147483647,
      match: { versionedExpr: "SRC_IPS_V1", config: { srcIpRanges: ["*"] } },
      description: "Default allow",
    },
  ],
});
