/**
 * The choudoufu member kind, shipped as a kinds-only package (#2545). The
 * scenarios are behold's: an estate declares itself with an estate.chdf.hcl
 * sidecar or with a live block in a root .tf file, and a directory that is
 * both a choudoufu estate and a plain Terraform root reads as choudoufu.
 */
import { join } from "node:path";
import { describeWorkspaceKindConformance } from "@intentius/chant-test-utils";

const root = `terraform {\n  required_version = ">= 1.5.0"\n}\n\nresource "null_resource" "x" {}\n`;
const liveRoot = `terraform {\n  live {\n    estate = "prod-networking"\n  }\n}\n\nresource "null_resource" "x" {}\n`;

describeWorkspaceKindConformance({
  packageDir: join(import.meta.dirname, ".."),
  scenarios: [
    { name: "a root with the estate.chdf.hcl sidecar", kind: "choudoufu", files: { "main.tf": root, "estate.chdf.hcl": 'estate = "prod-networking"\n' }, claims: true },
    { name: "a root with a live block in its terraform block", kind: "choudoufu", files: { "main.tf": liveRoot }, claims: true },
    { name: "a live block in a file not named main.tf", kind: "choudoufu", files: { "versions.tf": liveRoot, "main.tf": root }, claims: true },
    { name: "a chant project beside a live root", kind: "choudoufu", files: { "main.tf": liveRoot, "chant.config.ts": "" }, claims: true },
    { name: "a stock root", kind: "choudoufu", files: { "main.tf": root }, claims: false },
    { name: "live mentioned but not opened as a block", kind: "choudoufu", files: { "main.tf": `# live { is a choudoufu block\nlocals {\n  live = true\n}\n` }, claims: false },
    { name: "a live block in a called module one level down", kind: "choudoufu", files: { "modules/net/main.tf": liveRoot }, claims: false },
    { name: "a live block in a file that is not .tf", kind: "choudoufu", files: { "notes.hcl": liveRoot }, claims: false },
  ],
});
