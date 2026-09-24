/**
 * The terraform member kind this lexicon supplies to a chant workspace
 * (#2545). The kind is data in `workspace-kinds.json` at the package root,
 * exported at `./workspace-kinds`; chant reads it without importing the
 * lexicon.
 */
import { join } from "node:path";
import { describeWorkspaceKindConformance } from "@intentius/chant-test-utils";

const main = `terraform {\n  required_version = ">= 1.5.0"\n}\n\nresource "null_resource" "x" {}\n`;

describeWorkspaceKindConformance({
  packageDir: join(import.meta.dirname, ".."),
  scenarios: [
    { name: "a root with main.tf", kind: "terraform", files: { "main.tf": main }, claims: true },
    { name: "a root whose files are not named main.tf", kind: "terraform", files: { "network.tf": main, "versions.tf": "" }, claims: true },
    { name: "a root that has only been planned, lock file and all", kind: "terraform", files: { "main.tf": main, ".terraform.lock.hcl": "" }, claims: true },
    // chant's own precedence (500) outranks terraform's (400): no tie.
    { name: "a chant project beside its .tf files", kind: "terraform", files: { "main.tf": main, "chant.config.ts": "" }, claims: true },
    { name: "a directory whose modules sit one level down", kind: "terraform", files: { "modules/net/main.tf": main }, claims: false },
    { name: "variable and backend files alone", kind: "terraform", files: { "terraform.tfvars": "", "backend.tfbackend": "" }, claims: false },
  ],
});
