/**
 * GitLab CI/CD predefined variable references.
 *
 * These expand to $CI_* variable strings in the serialized YAML.
 * Provided for type-safe access and autocompletion.
 */

export const CI = {
  CommitBranch: "$CI_COMMIT_BRANCH",
  CommitRef: "$CI_COMMIT_REF_NAME",
  CommitSha: "$CI_COMMIT_SHA",
  CommitTag: "$CI_COMMIT_TAG",
  DefaultBranch: "$CI_DEFAULT_BRANCH",
  Environment: "$CI_ENVIRONMENT_NAME",
  JobId: "$CI_JOB_ID",
  JobName: "$CI_JOB_NAME",
  JobStage: "$CI_JOB_STAGE",
  MergeRequestIid: "$CI_MERGE_REQUEST_IID",
  PipelineId: "$CI_PIPELINE_ID",
  PipelineSource: "$CI_PIPELINE_SOURCE",
  ProjectDir: "$CI_PROJECT_DIR",
  ProjectId: "$CI_PROJECT_ID",
  ProjectName: "$CI_PROJECT_NAME",
  ProjectPath: "$CI_PROJECT_PATH",
  Registry: "$CI_REGISTRY",
  RegistryImage: "$CI_REGISTRY_IMAGE",
} as const;
