/**
 * A workspace member's pipelines (#2542, #2524 D19): the component workflow
 * and the Op workflows, scoped to one member through `options.member`.
 * Without `options.member` both generators are unchanged, which the other
 * suites in this directory hold.
 */

import { describe, test, expect } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import type { DriverComponent } from "@intentius/chant/components/driver";
import type { PipelineMember } from "@intentius/chant/lexicon";
import { buildGithubPipelineDoc, generateGithubPipeline } from "./generate-pipeline";
import { generateGithubOpPipeline } from "./generate-op-pipeline";

const components: DriverComponent[] = [
  { name: "shared-alb", dependsOn: [], deploy: [] },
  {
    name: "api",
    dependsOn: ["shared-alb"],
    deploy: [
      { phase: "Build", steps: [{ kind: "docker-build", context: ".", into: "dist/api.tar" }] },
      { phase: "Publish", steps: [{ kind: "publish-image", from: "archive:dist/api.tar" }] },
    ],
  },
];

const api: PipelineMember = { name: "api", dir: "services/api", file: ".github/workflows/chant-api-staging.yml" };

interface Step {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}
type Doc = {
  name: string;
  on: Record<string, { paths?: string[]; branches?: string[] } | null>;
  defaults?: { run: { "working-directory": string } };
  jobs: Record<string, { steps: Step[]; defaults?: { run: { "working-directory": string } } }>;
};

describe("generateGithubPipeline for a workspace member", () => {
  test("the triggers are the plain pipeline's: no push or pull_request is added to a deploy pipeline", () => {
    const member = parseYAML(generateGithubPipeline(components, { env: "staging", member: api }).yaml) as unknown as Doc;
    const plain = parseYAML(generateGithubPipeline(components, { env: "staging" }).yaml) as unknown as Doc;
    expect(member.on).toEqual(plain.on);
    expect(Object.keys(member.on)).toEqual(["workflow_dispatch"]);
  });

  test("run steps start in the member's directory, and the name carries the member", () => {
    const doc = parseYAML(generateGithubPipeline(components, { env: "staging", member: api }).yaml) as unknown as Doc;
    expect(doc.defaults).toEqual({ run: { "working-directory": "services/api" } });
    expect(doc.name).toBe("chant-components-api-staging");
  });

  test("artifact paths move under the member's directory, where the run steps write them", () => {
    const doc = parseYAML(generateGithubPipeline(components, { env: "staging", promoteTo: "prod", member: api }).yaml) as unknown as Doc;
    const shared = doc.jobs["shared-alb"].steps.find((s) => s.uses?.startsWith("actions/upload-artifact"));
    expect(shared?.with?.path).toBe("services/api/shared-alb.outputs.json");
    const download = doc.jobs["api"].steps.find((s) => s.uses?.startsWith("actions/download-artifact"));
    expect(download?.with?.path).toBe("services/api");
    const archive = doc.jobs["api"].steps.find((s) => (s.with?.name as string | undefined) === "api-archive");
    expect(archive?.with?.path).toBe("services/api/dist/api.tar");
    const promoteDownload = doc.jobs["promote-prod"].steps.find((s) => s.uses?.startsWith("actions/download-artifact"));
    expect(promoteDownload?.with?.path).toBe("services/api/dist");
    // The digest the promote job pins (#2602) is written and read by run
    // steps, so it needs no path change.
    expect(doc.jobs["api"].steps.some((s) => s.run?.includes("--digest-file api.digest"))).toBe(true);
    expect(doc.jobs["promote-prod"].steps.some((s) => s.run?.includes('--digest "api=${{ needs.api.outputs.digest }}"'))).toBe(true);
    // The run lines themselves are unchanged: they run in the member's directory.
    expect(doc.jobs["api"].steps.some((s) => s.run?.includes("--seed-outputs shared-alb.outputs.json"))).toBe(true);
  });

  test("a member at the root keeps the root as its directory", () => {
    const root: PipelineMember = { name: "platform", dir: ".", exclude: ["services/api", "examples/a"], file: ".github/workflows/chant-platform-prod.yml" };
    const doc = buildGithubPipelineDoc(components, { env: "prod", member: root });
    expect(doc.on).toEqual({ workflow_dispatch: {} });
    expect(doc.defaults).toBeUndefined();
    const upload = (doc.jobsDoc["shared-alb"] as { steps: Step[] }).steps.find((s) => s.uses?.startsWith("actions/upload-artifact"));
    expect(upload?.with?.path).toBe("shared-alb.outputs.json");
  });

  test("two members' pipelines differ only where the member does", () => {
    const web: PipelineMember = { name: "web", dir: "apps/web", file: ".github/workflows/chant-web-staging.yml" };
    const a = generateGithubPipeline(components, { env: "staging", member: api });
    const b = generateGithubPipeline(components, { env: "staging", member: web });
    expect(a.yaml).not.toBe(b.yaml);
    expect(a.jobs).toEqual(b.jobs);
  });
});

describe("generateGithubOpPipeline for a workspace member", () => {
  const member: PipelineMember = { name: "api", dir: "services/api", fileDir: ".github/workflows" };

  test("files, workflow names and concurrency groups carry the member's name", () => {
    const result = generateGithubOpPipeline([{ name: "nightly", trigger: { kind: "cron", schedule: "0 6 * * *" } }], { member });
    expect(result.files.map((f) => f.name)).toEqual(["api-nightly.yml"]);
    const doc = parseYAML(result.files[0].yaml) as unknown as Doc & { concurrency: { group: string } };
    expect(doc.name).toBe("api/nightly");
    expect(doc.concurrency.group).toBe("api-nightly");
    // A cron trigger has no paths to filter.
    expect(JSON.stringify(doc.on)).not.toContain("paths");
    expect(doc.jobs["nightly"].defaults).toEqual({ run: { "working-directory": "services/api" } });
  });

  test("push and pull_request triggers are filtered to the member and the Op's own file", () => {
    const result = generateGithubOpPipeline(
      [
        { name: "plan", trigger: { kind: "pull_request" } },
        { name: "apply", trigger: { kind: "push" } },
      ],
      { member },
    );
    const plan = parseYAML(result.files[0].yaml) as unknown as Doc;
    expect(plan.on.pull_request).toEqual({ paths: ["services/api/**", ".github/workflows/api-plan.yml"] });
    const apply = parseYAML(result.files[1].yaml) as unknown as Doc;
    expect(apply.on.push).toEqual({ branches: ["main"], paths: ["services/api/**", ".github/workflows/api-apply.yml"] });
    // The gate-notice job checks nothing out, so it keeps the default directory.
    expect(apply.jobs["apply-gate-notice"].defaults).toBeUndefined();
    expect(apply.jobs["apply"].defaults).toEqual({ run: { "working-directory": "services/api" } });
  });
});
