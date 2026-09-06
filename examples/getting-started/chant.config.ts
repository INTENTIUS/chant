import type { ChantConfig } from "@intentius/chant";

// `lexicons` is read by chant — `k8s` for the resource types and the kubectl
// activity. `ownership` stamps a marker on each resource so the L4 dial
// (reconcile/apply) can scope to chant-owned resources. L1/L2 need nothing
// here at runtime; L3's gate is decided against the gate ledger, which lives
// on this repo's own `chant/lifecycle` branch rather than in any config.
export default {
  lexicons: ["k8s"],
  ownership: { stack: "getting-started", env: "local" },
} satisfies ChantConfig;
