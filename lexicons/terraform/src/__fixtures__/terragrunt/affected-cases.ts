/**
 * Changes to the `affected/` fixture and what each selects (#3415). Shared by
 * `terragrunt/affected.test.ts`, which feeds the recorded `terragrunt` column
 * to the selection, and `terragrunt/affected.acceptance.test.ts`, which makes
 * each change as a commit and checks the column against a real Terragrunt.
 *
 * `terragrunt` is what Terragrunt's own `[base...HEAD]` filter selected
 * (observed on 1.1.6 and 1.2.0-rc1). The supplement cases select nothing
 * there: that column is the red half of each supplement.
 */

import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TerragruntAffectedUnit } from "../../terragrunt/affected";

export interface AffectedCase {
  name: string;
  /** Make the change in a copy of the fixture. */
  change: (dir: string) => void;
  /** What `git diff --name-only` lists for the change. */
  changed: string[];
  /** What Terragrunt's own git filter selects, catalog excluded. */
  terragrunt: string[];
  expected: TerragruntAffectedUnit[];
}

const touch = (file: string) => (dir: string) => appendFileSync(join(dir, file), "\n# changed\n");

export const AFFECTED_CASES: AffectedCase[] = [
  {
    name: "a unit's own terragrunt.hcl",
    change: touch("live/dev/vpc/terragrunt.hcl"),
    changed: ["live/dev/vpc/terragrunt.hcl"],
    terragrunt: ["live/dev/vpc"],
    expected: [{ path: "live/dev/vpc", reasons: [{ kind: "terragrunt", files: ["live/dev/vpc/terragrunt.hcl"] }] }],
  },
  {
    name: "a .tf file of the units' module",
    change: touch("modules/app/main.tf"),
    changed: ["modules/app/main.tf"],
    terragrunt: ["live/dev/app", "live/prod/app"],
    expected: [
      { path: "live/dev/app", reasons: [{ kind: "terragrunt", files: ["modules/app/main.tf"] }] },
      { path: "live/prod/app", reasons: [{ kind: "terragrunt", files: ["modules/app/main.tf"] }] },
    ],
  },
  {
    name: "the root.hcl every unit includes",
    change: touch("root.hcl"),
    changed: ["root.hcl"],
    terragrunt: ["live/dev/app", "live/dev/vpc", "live/prod/app", "live/stg/.terragrunt-stack/web"],
    expected: ["live/dev/app", "live/dev/vpc", "live/prod/app", "live/stg/.terragrunt-stack/web"].map((path) => ({
      path,
      reasons: [{ kind: "terragrunt" as const, files: ["root.hcl"] }],
    })),
  },
  {
    name: "supplement 1: a file the module reads with file()",
    change: (dir) => writeFileSync(join(dir, "modules/app/policy.json"), '{"allow": ["read", "write"]}\n'),
    changed: ["modules/app/policy.json"],
    terragrunt: [],
    expected: [
      { path: "live/dev/app", reasons: [{ kind: "module-file", files: ["modules/app/policy.json"], via: "modules/app" }] },
      { path: "live/prod/app", reasons: [{ kind: "module-file", files: ["modules/app/policy.json"], via: "modules/app" }] },
    ],
  },
  {
    name: "supplement 2: a module the units' module calls",
    change: touch("modules/net/main.tf"),
    changed: ["modules/net/main.tf"],
    terragrunt: [],
    expected: [
      { path: "live/dev/app", reasons: [{ kind: "module-call", files: ["modules/net/main.tf"], via: "modules/net" }] },
      { path: "live/prod/app", reasons: [{ kind: "module-call", files: ["modules/net/main.tf"], via: "modules/net" }] },
    ],
  },
  {
    name: "supplement 3: the stack's local unit template",
    change: touch("catalog/units/web/terragrunt.hcl"),
    changed: ["catalog/units/web/terragrunt.hcl"],
    terragrunt: [],
    expected: [
      {
        path: "live/stg/.terragrunt-stack/web",
        reasons: [{ kind: "stack-template", files: ["catalog/units/web/terragrunt.hcl"], via: "catalog/units/web" }],
      },
    ],
  },
  {
    // A comment-only edit generates the same unit, and Terragrunt then selects nothing.
    name: "a value in the stack file",
    change: (dir) => {
      const f = join(dir, "live/stg/terragrunt.stack.hcl");
      writeFileSync(f, readFileSync(f, "utf8").replace('"stg-web"', '"stg-web-2"'));
    },
    changed: ["live/stg/terragrunt.stack.hcl"],
    terragrunt: ["live/stg/.terragrunt-stack/web"],
    expected: [{ path: "live/stg/.terragrunt-stack/web", reasons: [{ kind: "terragrunt", files: ["live/stg/terragrunt.stack.hcl"] }] }],
  },
  {
    name: "a removed unit",
    change: (dir) => rmSync(join(dir, "live/prod/app"), { recursive: true }),
    changed: ["live/prod/app/terragrunt.hcl"],
    terragrunt: ["live/prod/app"],
    expected: [{ path: "live/prod/app", reasons: [{ kind: "removed", files: ["live/prod/app/terragrunt.hcl"] }] }],
  },
  {
    name: "a unit's own file and its module's data file together",
    change: (dir) => {
      touch("live/dev/app/terragrunt.hcl")(dir);
      writeFileSync(join(dir, "modules/app/policy.json"), "{}\n");
    },
    changed: ["live/dev/app/terragrunt.hcl", "modules/app/policy.json"],
    terragrunt: ["live/dev/app"],
    expected: [
      {
        path: "live/dev/app",
        reasons: [
          { kind: "terragrunt", files: ["live/dev/app/terragrunt.hcl"] },
          { kind: "module-file", files: ["modules/app/policy.json"], via: "modules/app" },
        ],
      },
      { path: "live/prod/app", reasons: [{ kind: "module-file", files: ["modules/app/policy.json"], via: "modules/app" }] },
    ],
  },
];
