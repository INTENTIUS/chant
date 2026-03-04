import { describe, test, expect } from "bun:test";
import { CI } from "./variables";

describe("CI variables", () => {
  test("all values start with $CI_", () => {
    for (const [key, value] of Object.entries(CI)) {
      expect(value).toMatch(/^\$CI_/);
    }
  });

  test("all values are non-empty strings", () => {
    for (const [key, value] of Object.entries(CI)) {
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(0);
    }
  });

  test("contains expected commit variables", () => {
    expect(CI.CommitBranch).toBe("$CI_COMMIT_BRANCH");
    expect(CI.CommitRef).toBe("$CI_COMMIT_REF_NAME");
    expect(CI.CommitRefSlug).toBe("$CI_COMMIT_REF_SLUG");
    expect(CI.CommitSha).toBe("$CI_COMMIT_SHA");
    expect(CI.CommitTag).toBe("$CI_COMMIT_TAG");
  });

  test("contains expected project variables", () => {
    expect(CI.ProjectDir).toBe("$CI_PROJECT_DIR");
    expect(CI.ProjectId).toBe("$CI_PROJECT_ID");
    expect(CI.ProjectName).toBe("$CI_PROJECT_NAME");
    expect(CI.ProjectPath).toBe("$CI_PROJECT_PATH");
  });

  test("contains expected pipeline variables", () => {
    expect(CI.PipelineId).toBe("$CI_PIPELINE_ID");
    expect(CI.PipelineSource).toBe("$CI_PIPELINE_SOURCE");
    expect(CI.JobId).toBe("$CI_JOB_ID");
    expect(CI.JobName).toBe("$CI_JOB_NAME");
    expect(CI.JobStage).toBe("$CI_JOB_STAGE");
  });

  test("contains expected registry variables", () => {
    expect(CI.Registry).toBe("$CI_REGISTRY");
    expect(CI.RegistryImage).toBe("$CI_REGISTRY_IMAGE");
    expect(CI.RegistryUser).toBe("$CI_REGISTRY_USER");
    expect(CI.RegistryPassword).toBe("$CI_REGISTRY_PASSWORD");
  });

  test("contains environment variables", () => {
    expect(CI.Environment).toBe("$CI_ENVIRONMENT_NAME");
    expect(CI.EnvironmentSlug).toBe("$CI_ENVIRONMENT_SLUG");
    expect(CI.DefaultBranch).toBe("$CI_DEFAULT_BRANCH");
    expect(CI.MergeRequestIid).toBe("$CI_MERGE_REQUEST_IID");
  });

  test("exports at least 20 variables", () => {
    expect(Object.keys(CI).length).toBeGreaterThanOrEqual(20);
  });
});
