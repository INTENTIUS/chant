/**
 * Module targets: publishing a module version to a hosted registry on chant
 * core's publish-target contract (chant#4602): GitLab (chant#4603), HCP
 * Terraform or Terraform Enterprise (chant#4604), and Artifactory and Nexus
 * (chant#4605), which take the zip of the attested archive (./zip). The
 * fakes the tests drive them with are at `registry/targets/fake-<host>`,
 * with `fake-http` holding a module tarball builder, outside this index, so
 * a product's tests can reach them without shipping them in its own code
 * paths.
 */
export * from "./module-target";
export * from "./gitlab";
export * from "./hcp";
export * from "./zip";
export * from "./hosted";
export * from "./artifactory";
export * from "./nexus";
