/** #4753: a GitLab Op job's own id_tokens, cache and schedule rule. */
import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { generateGitlabOpPipeline } from "./generate-op-pipeline";
import type { ScheduledOpSpec } from "@intentius/chant/lexicon";

const gen = (spec: ScheduledOpSpec) => generateGitlabOpPipeline([spec]).files[0]!.yaml;
const job = (spec: ScheduledOpSpec) => (parseYAML(gen(spec)) as Record<string, Record<string, unknown>>)[spec.name]!;

describe("ScheduledOpSpec.gitlab (#4753)", () => {
  const drift: ScheduledOpSpec = {
    name: "drift",
    schedule: "0 6 * * *",
    permissions: { "id-token": "write" },
    gitlab: {
      idTokens: { TERRAGUCCI_OIDC: { aud: "sts.amazonaws.com" }, TERRAGUCCI_OIDC_GCP: { aud: ["https://iam.googleapis.com/x"] } },
      cache: { key: "tg-$CI_COMMIT_REF_SLUG", paths: [".terragrunt-cache/"] },
      scheduleRule: '$CI_PIPELINE_SOURCE == "schedule" && $TERRAGUCCI_SCHEDULE != "comments"',
    },
  };

  test("named id_tokens join chant's, the cache is the job's, and the schedule rule replaces the selector", () => {
    const j = job(drift);
    expect(j.id_tokens).toEqual({ CHANT_ID_TOKEN: { aud: "$CI_SERVER_URL" }, TERRAGUCCI_OIDC: { aud: "sts.amazonaws.com" }, TERRAGUCCI_OIDC_GCP: { aud: ["https://iam.googleapis.com/x"] } });
    expect(j.cache).toEqual({ key: "tg-$CI_COMMIT_REF_SLUG", paths: [".terragrunt-cache/"] });
    expect(j.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "schedule" && $TERRAGUCCI_SCHEDULE != "comments"' }]);
    expect(gen(drift)).toContain(`#   drift: cron "0 6 * * *", a schedule that matches $CI_PIPELINE_SOURCE == "schedule" && $TERRAGUCCI_SCHEDULE != "comments"`);
  });

  test("a spec without gitlab renders as before", () => {
    const j = job({ name: "drift", schedule: "0 6 * * *" });
    expect(j.rules).toEqual([{ if: '$CI_PIPELINE_SOURCE == "schedule" && $CHANT_SCHEDULED_OP == "drift"' }]);
    expect(j).not.toHaveProperty("cache");
    expect(j).not.toHaveProperty("id_tokens");
  });

  test("a token name chant uses, a bad name, and a schedule rule off cron are refused", () => {
    expect(() => gen({ ...drift, gitlab: { idTokens: { CHANT_ID_TOKEN: { aud: "x" } } } })).toThrow(/chant declares for this job already/);
    expect(() => gen({ ...drift, gitlab: { idTokens: { "bad-name": { aud: "x" } } } })).toThrow(/not a variable name/);
    expect(() => gen({ name: "plan", trigger: { kind: "pull_request" }, gitlab: { scheduleRule: "$X" } })).toThrow(/scheduleRule picks the pipeline schedule of a cron trigger/);
  });
});
