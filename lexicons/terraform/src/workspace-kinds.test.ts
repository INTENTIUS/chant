/**
 * The terraform and choudoufu member kinds this lexicon supplies to a chant
 * workspace (#2545). Both are data in `workspace-kinds.json` at the package
 * root, exported at `./workspace-kinds`; chant reads it without importing the
 * lexicon. A choudoufu estate is a Terraform root with an estate.chdf.hcl
 * sidecar or a live block, which this lexicon's choudoufu mode reads.
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
    // choudoufu (450) outranks terraform (400) on the same root.
    { name: "a root with the estate.chdf.hcl sidecar", kind: "choudoufu", files: { "main.tf": main, "estate.chdf.hcl": "" }, claims: true },
    { name: "a root with a live block", kind: "choudoufu", files: { "main.tf": main + '\nlive {\n  name = "prod"\n}\n' }, claims: true },
    { name: "a stock root", kind: "choudoufu", files: { "main.tf": main }, claims: false },
  ],
});
