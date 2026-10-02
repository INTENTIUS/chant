import { join } from "node:path";
import { describeWorkspaceKindConformance } from "./workspace-kind-conformance";

// A kinds-only package, the smallest shape a plugin can take (#2535).
describeWorkspaceKindConformance({
  packageDir: join(import.meta.dirname, "__fixtures__", "workspace-kinds-plugin"),
  scenarios: [
    { name: "a root module", kind: "terraform", files: { "main.tf": "" }, claims: true },
    { name: "a module with only versions.tf", kind: "terraform", files: { "versions.tf": "" }, claims: true },
    { name: "a module nested one level down", kind: "terraform", files: { "modules/net/main.tf": "" }, claims: false },
    // chant's own precedence (500) wins over terraform's (400): no tie.
    { name: "a chant project that also has main.tf", kind: "terraform", files: { "main.tf": "", "chant.config.ts": "" }, claims: true },
    { name: "a chart", kind: "helm-chart", files: { "Chart.yaml": "name: x\n" }, claims: true },
    { name: "a values file alone", kind: "helm-chart", files: { "values.yaml": "" }, claims: false },
  ],
});
