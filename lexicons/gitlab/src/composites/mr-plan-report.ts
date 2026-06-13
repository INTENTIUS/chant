import { Composite, mergeDefaults } from "@intentius/chant";
import { Job, Image, Artifacts } from "../generated";

export interface MrPlanReportProps {
  /**
   * Lifecycle environment to plan against — the `<environment>` argument of
   * `chant lifecycle plan`.
   */
  environment: string;
  /** Restrict the plan to one lexicon (the optional `[lexicon]` argument). */
  lexicon?: string;
  /** Stage for the plan job. Default: `"plan"` */
  stage?: string;
  /** Image to run chant in. Default: `"node:22-alpine"` */
  image?: string;
  /** Plan against chant-owned resources only (passes `--owned`). */
  ownedOnly?: boolean;
  /** Artifact filename the report is written to. Default: `"tfplan.json"` */
  reportFile?: string;
  /**
   * Commands to run before the plan — typically cloud-credential setup, since
   * the plan queries the live system to classify create/update/delete.
   */
  before?: string[];
  /** Per-member defaults for customizing the generated job. */
  defaults?: {
    plan?: Partial<ConstructorParameters<typeof Job>[0]>;
  };
}

/**
 * A CI job that publishes `chant lifecycle plan` as the GitLab merge-request
 * plan widget.
 *
 * The job runs the plan with `--report gitlab-mr`, writes the count JSON to a
 * file, and declares it as `artifacts:reports:terraform`. GitLab then renders
 * "N to add, M to change, K to delete" on the MR — the same widget Terraform
 * uses. The label reads "Terraform" regardless of producer; that is GitLab's
 * fixed string. Counts are create/update/delete only — `adopt` and `noop` do
 * not appear.
 *
 * The plan reads the live system to classify drift, so wire cloud credentials
 * via `before` or CI variables.
 */
export const MrPlanReport = Composite<MrPlanReportProps>((props) => {
  const {
    environment,
    lexicon,
    stage = "plan",
    image = "node:22-alpine",
    ownedOnly = false,
    reportFile = "tfplan.json",
    before,
    defaults: defs,
  } = props;

  const planArgs = [
    "lifecycle",
    "plan",
    environment,
    ...(lexicon ? [lexicon] : []),
    ...(ownedOnly ? ["--owned"] : []),
    "--report",
    "gitlab-mr",
  ].join(" ");

  const plan = new Job(mergeDefaults({
    stage,
    image: new Image({ name: image }),
    ...(before ? { before_script: before } : {}),
    script: [
      "npx chant build",
      `npx chant ${planArgs} > ${reportFile}`,
    ],
    artifacts: new Artifacts({
      reports: { terraform: reportFile },
      when: "always",
    }),
  }, defs?.plan));

  return { plan };
}, "MrPlanReport");
