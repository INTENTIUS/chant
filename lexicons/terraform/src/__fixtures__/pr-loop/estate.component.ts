import { phase, stackOutput, type Component } from "@intentius/chant/components";

const apply = (root: string, vars?: Record<string, unknown>) =>
  [phase("Apply", [{ kind: "terraform-apply", root, noRollback: "test roots with local state", vars: vars ?? {} }])];

export const net: Component = { name: "net", dependsOn: [], deploy: apply("net") };
export const a: Component = { name: "a", dependsOn: ["net"], deploy: apply("a", { cidr: stackOutput("net", "cidr") }) };
export const b: Component = { name: "b", dependsOn: ["net"], deploy: apply("b", { cidr: stackOutput("net", "cidr") }) };
export const app: Component = { name: "app", dependsOn: ["a"], deploy: apply("app", { subnet: stackOutput("a", "id") }) };
export const dns: Component = { name: "dns", dependsOn: [], deploy: apply("dns") };
