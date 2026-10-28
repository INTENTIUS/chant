/**
 * Module targets: publishing a module version to a hosted registry on chant
 * core's publish-target contract (chant#4602): GitLab (chant#4603) and HCP
 * Terraform or Terraform Enterprise (chant#4604). The fakes the
 * tests drive them with are at `registry/targets/fake-<host>`, outside this
 * index, so a product's tests can reach them without shipping them in its
 * own code paths.
 */
export * from "./module-target";
export * from "./gitlab";
export * from "./hcp";
