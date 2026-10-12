/**
 * The dbt member kind this lexicon supplies to a chant workspace (#3932). It
 * is data in `workspace-kinds.json` at the package root, exported at
 * `./workspace-kinds`; chant reads it without importing the lexicon. A dbt
 * project's sources read the tables a sql member declares.
 */
import { join } from "node:path";
import { describeWorkspaceKindConformance } from "@intentius/chant-test-utils";

const project = "name: analytics\nversion: '1.0'\nprofile: analytics\n";

describeWorkspaceKindConformance({
  packageDir: join(import.meta.dirname, ".."),
  scenarios: [
    { name: "a dbt project", kind: "dbt", files: { "dbt_project.yml": project, "models/sources.yml": "version: 2\n" }, claims: true },
    // chant's own precedence (500) outranks dbt's (300): no tie.
    { name: "a chant project beside a dbt_project.yml", kind: "dbt", files: { "dbt_project.yml": project, "chant.config.ts": "" }, claims: true },
    { name: "a directory whose dbt project sits one level down", kind: "dbt", files: { "analytics/dbt_project.yml": project }, claims: false },
    { name: "models without a project file", kind: "dbt", files: { "models/sources.yml": "version: 2\n" }, claims: false },
  ],
});
