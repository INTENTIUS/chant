import type { ChantConfig } from "@intentius/chant";

// `lint.policies` registers project-authored organizational policy checks. They
// run during `chant build` over the resolved resources, with `--env` in
// context, and fail the build on violation. Distinct from `plugins` (declarative
// lint rules) by authorship and phase — same engine.
export default {
  lexicons: ["k8s"],
  ownership: { stack: "storefront" },
  lint: { policies: ["policies/org.ts"] },
} satisfies ChantConfig;
