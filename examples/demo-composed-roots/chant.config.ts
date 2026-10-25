// Three Terraform roots, each applied on its own: network, app on it, and edge
// on app. Nothing here states the order they apply in: chant reads dependsOn
// off the *.component.ts files and derives it from the change.
//
// A .ts config with no imports, which behold reads as a chant project, so a
// checkout with no node_modules evaluates it.
export default {
  // The terraform lexicon reads the roots and brings the terraform-apply step.
  lexicons: ["terraform"],

  // demo: the stack's floci, as the jobs and the driver reach it on the
  // stack's network. AWS_ENDPOINT_URL names the same address in each job.
  environments: [{ name: "demo", endpoint: "http://floci:4566" }],

  terraform: {
    binary: "tofu",
    // A change that reaches several roots plans them as one plan and applies
    // them as one apply, so a value one root creates reaches its readers in
    // that apply.
    compose: { enabled: true },
    roots: {
      network: { dir: "roots/network" },
      app: { dir: "roots/app" },
      edge: { dir: "roots/edge" },
    },
  },
};
