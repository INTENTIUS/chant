/**
 * TF023 (#2110): Terraform state, or the `.terraform/` working directory,
 * committed to the repository.
 *
 * Every other rule in the TF family is a post-synth check over a parsed root
 * module, contributed by the terraform lexicon. This one is not about HCL at
 * all: the finding is that a path exists in version control, so there is
 * nothing for `chant build` to check and nothing for the lexicon's parser to
 * read. It therefore takes the shape `secrets.ts` established and `wrangler.ts`
 * and `nginx.ts` copied, a path detector plus a check over the discovered file
 * list, called from the audit CLI beside `scanForSecrets`, with its catalog
 * entry in core's own `RULE_CATALOG` (./catalog.ts) rather than a lexicon's.
 * It runs whether or not the terraform lexicon is installed.
 *
 * A state file is a committed secret store: it records every attribute of every
 * managed resource, including the ones providers mark sensitive, in plaintext
 * JSON. `.terraform/` is milder (providers and vendored modules) but is still
 * hundreds of megabytes of machine-generated content, and it can hold a
 * `terraform.tfstate` of its own for the workspace-local backend.
 *
 * Pure: no fs, no network, no Node-only global, so it is Workers-safe (epic #350). The
 * walk that decides which paths reach here is `discover.ts`'s
 * `collectCandidates`, which is also where a locally ignored path is dropped:
 * see `isTerraformStatePath` there and `gitignoreCoversTerraformState` below.
 */

import type { AuditFinding } from "./core";

/** The minimal file shape the check needs (matches `discover.ts`'s `RepoFile`). */
export interface ScannableFile {
  path: string;
  content: string;
}

/** `terraform.tfstate`, `terraform.tfstate.backup`, and any other `*.tfstate`. */
export function isTerraformStateFile(path: string): boolean {
  const name = path.split("/").pop() ?? path;
  return /\.tfstate(\.backup)?$/i.test(name);
}

/** The `.terraform` working directory itself, or anything inside it. */
export function isTerraformWorkDir(path: string): boolean {
  const parts = path.split("/");
  return parts.includes(".terraform");
}

/** Either of the two shapes TF023 reports. */
export function isTerraformStatePath(path: string): boolean {
  return isTerraformStateFile(path) || isTerraformWorkDir(path);
}

/**
 * Does a `.gitignore` body already exclude Terraform state? Deliberately
 * narrow: it recognises the handful of patterns the style guide's own
 * `.gitignore` section and `github/gitignore`'s `Terraform.gitignore` use
 * (`*.tfstate`, `*.tfstate.*`, `.terraform/`, `.terraform*`, with an optional
 * leading slash or a leading double-star), not the whole gitignore grammar. A repository that
 * writes something more exotic gets a finding it can suppress; the alternative,
 * a partial gitignore engine, would be wrong in quieter ways.
 *
 * Used by the local walk only (`discover.ts`), where "on disk" and "tracked by
 * git" are different questions and nearly every Terraform working tree has an
 * ignored `.terraform/` in it. A fetched repository's file list is already
 * exactly the tracked files, so nothing filters it.
 */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function gitignoreCoversTerraformState(gitignore: string, path: string): boolean {
  const name = path.split("/").pop() ?? path;
  for (const raw of gitignore.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith("!")) continue;
    const pattern = line.replace(/^\*\*\//, "").replace(/^\//, "").replace(/\/$/, "");
    if (pattern === "" || pattern.includes("/")) continue;
    // `*` matches within one path segment, as git's own glob does. The pattern
    // is compared against the file's own name and against every segment of its
    // path, which is what makes `.terraform/` match `infra/prod/.terraform`.
    const re = new RegExp(`^${pattern.split("*").map(escapeRegExp).join("[^/]*")}$`);
    if (re.test(name) || path.split("/").some((segment) => re.test(segment))) return true;
  }
  return false;
}

/**
 * Report TF023 for every committed state file and `.terraform/` directory in
 * the file list. One finding per path, and one for the `.terraform` directory
 * as a whole rather than per file inside it: a vendored provider binary is not
 * a separate finding from the directory that holds it.
 */
export function auditTerraformState(files: ScannableFile[]): AuditFinding[] {
  const findings: AuditFinding[] = [];
  const workDirs = new Set<string>();

  for (const file of files) {
    if (isTerraformWorkDir(file.path)) {
      const parts = file.path.split("/");
      const dir = parts.slice(0, parts.indexOf(".terraform") + 1).join("/");
      if (workDirs.has(dir)) continue;
      workDirs.add(dir);
      findings.push({
        checkId: "TF023",
        severity: "warning",
        message:
          `\`${dir}\` is committed to the repository. Terraform's working directory holds downloaded ` +
          "providers and vendored child modules, and the local backend keeps its state there too. " +
          "Delete it from version control and add `.terraform/` to .gitignore.",
        file: dir,
        lexicon: "terraform",
        entity: ".terraform",
      });
      continue;
    }
    if (!isTerraformStateFile(file.path)) continue;
    findings.push({
      checkId: "TF023",
      severity: "error",
      message:
        `\`${file.path}\` is committed to the repository. A state file records every attribute of every ` +
        "managed resource in plaintext, including the ones providers mark sensitive, so a committed " +
        "state file is a committed secret store. Remove it from version control, add `*.tfstate` and " +
        "`*.tfstate.backup` to .gitignore, move the state to a remote backend, and rotate anything it held.",
      file: file.path,
      lexicon: "terraform",
      entity: file.path.split("/").pop() ?? file.path,
    });
  }

  return findings;
}
