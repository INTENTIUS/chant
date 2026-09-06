import type { ChantConfig } from "@intentius/chant";

// `lexicons` is read by chant. `sourceDir` scopes lifecycle builds to `src/`
// (this is a mixed-layout project — chant infra in src/ next to app/,
// activities/ and ops/), so `chant lifecycle plan/diff/snapshot` only
// synthesizes the infra. `ownership` stamps a stack-identity marker on every
// resource, so the lifecycle dial / drift source can scope to chant-owned
// resources (cf. the getting-started example).
export default {
  lexicons: ["k8s"],
  sourceDir: "src",
  ownership: { stack: "alert-triage", env: "local" },
} satisfies ChantConfig;
