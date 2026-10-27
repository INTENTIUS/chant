/**
 * #4549: with a Pulumi Cloud identity, the merge-request pipeline's plan and
 * record jobs trade their `id_tokens` for a preview token and the apply job
 * for an up token. No job reads a Pulumi token from a CI/CD variable, and
 * the plan job names no up token. Generated YAML only; the trade itself is
 * tested against the fake exchange in packages/core/src/ci-identity-pulumi.test.ts.
 */

import { describe, expect, test } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import { gitlabTradeLines, resolveCloudIdentity, TRADE_SPEC_ENV } from "@intentius/chant/ci-identity";
import { FORGE_TOKEN_VARS } from "@intentius/chant/ci-handover";
import { generateGitlabPipeline } from "./generate-pipeline";

const ESTATE: DriverComponent[] = [{ name: "app", dependsOn: [], deploy: [{ phase: "Apply", steps: [{ kind: "terraform-apply", root: "app" }] }] }];

const IDENTITY = resolveCloudIdentity({ pulumi: { organization: "acme", rules: [{ plan: "team:preview", apply: "team:deploy" }] } }, "prod")!;

interface GitlabJob {
  id_tokens?: Record<string, { aud: string }>;
  variables?: Record<string, string>;
  script: string[];
}

describe("the GitLab pipeline's Pulumi Cloud tokens (#4549)", () => {
  const { yaml } = generateGitlabPipeline(ESTATE, { env: "prod", image: "example/ci:1", prLoop: { applyOnMerge: true, identity: IDENTITY } });
  const doc = parseYAML(yaml) as Record<string, GitlabJob>;

  test("the plan job asks for the Pulumi id token and trades for the preview token before anything else", () => {
    expect(doc.plan!.id_tokens).toEqual({ CHANT_ID_TOKEN_PULUMI: { aud: "urn:pulumi:org:acme" } });
    expect(doc.plan!.script.slice(0, 3)).toEqual(gitlabTradeLines(FORGE_TOKEN_VARS));
    expect(JSON.parse(doc.plan!.variables![TRADE_SPEC_ENV]!)).toEqual(IDENTITY.plan);
  });

  test("the record job takes the preview token and the apply job the up token", () => {
    expect(JSON.parse(doc.record!.variables![TRADE_SPEC_ENV]!)).toEqual(IDENTITY.plan);
    expect(JSON.parse(doc.apply!.variables![TRADE_SPEC_ENV]!)).toEqual(IDENTITY.apply);
    expect(doc.apply!.id_tokens).toEqual(doc.plan!.id_tokens);
  });

  test("the plan job names no up token, and nothing reads PULUMI_ACCESS_TOKEN from a CI/CD variable", () => {
    expect(JSON.stringify(doc.plan)).not.toContain("team:deploy");
    expect(yaml).not.toContain("$PULUMI_ACCESS_TOKEN");
  });
});
