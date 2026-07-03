import type { Component } from "../../../../../components/component";
import { phase } from "../../../../../components/component";

/** Duplicate component name (see broken-b.component.ts) — exercises the COMP000 discovery-error surfacing path in component-checks.ts. */
export const dup: Component = {
  name: "duplicate-name",
  dependsOn: [],
  deploy: [phase("Apply", [{ kind: "cfn-deploy", template: "a.json" }])],
};
