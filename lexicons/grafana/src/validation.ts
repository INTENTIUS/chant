/**
 * `@intentius/chant-lexicon-grafana/validation`: the GRAF101-GRAF115 checks
 * as plain functions over built Grafana output, and the schema validation
 * behind GRAF107, for code that checks dashboards without a build.
 *
 * These are not on the package root, so importing the lexicon to declare
 * dashboards does not load them. `chant build` and `chant lint` run the same
 * checks through the plugin's post-synth checks. ajv is loaded the first time
 * a schema is checked, and the schemas come from a generated module rather
 * than files, so this works bundled.
 */

export {
  validateGrafanaOutput,
  issuesFor,
  knownDatasourcesOf,
  type GrafanaIssue,
  type GrafanaIssueCode,
  type GrafanaArtifacts,
  type DashboardDoc,
} from "./validate-output";
export {
  validateDashboardSchema,
  validateExpressionSchema,
  schemaValidationUnavailable,
  type SchemaProblem,
} from "./schema-validate";
