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
    // Migration directories (#4400).
    { name: "a goose directory", kind: "goose", files: { "00001_users.sql": "-- +goose Up\nCREATE TABLE users (id int);\n-- +goose Down\nDROP TABLE users;\n" }, claims: true },
    { name: "plain SQL files without goose sections", kind: "goose", files: { "00001_users.sql": "CREATE TABLE users (id int);\n" }, claims: false },
    { name: "a golang-migrate directory", kind: "golang-migrate", files: { "1_users.up.sql": "CREATE TABLE users (id int);\n", "1_users.down.sql": "DROP TABLE users;\n" }, claims: true },
    { name: "a golang-migrate directory beats clickhouse-migrations on the same file names", kind: "golang-migrate", files: { "1_users.up.sql": "select 1;\n" }, claims: true },
    { name: "migrations with no up files", kind: "golang-migrate", files: { "1_users.sql": "select 1;\n" }, claims: false },
    { name: "numbered SQL files", kind: "clickhouse-migrations", files: { "001_init.sql": "CREATE TABLE t (id UInt64) ENGINE = Memory;\n" }, claims: true },
    { name: "SQL files with no version", kind: "clickhouse-migrations", files: { "init.sql": "select 1;\n" }, claims: false },
    { name: "a Flyway project with a configuration file", kind: "flyway", files: { "flyway.toml": "[flyway]\n" }, claims: true },
    { name: "a Flyway directory with only migrations", kind: "flyway", files: { "V1__init.sql": "select 1;\n" }, claims: true },
    { name: "a directory with no Flyway files", kind: "flyway", files: { "schema.sql": "select 1;\n" }, claims: false },
  ],
});
