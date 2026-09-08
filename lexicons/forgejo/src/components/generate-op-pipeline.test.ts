/**
 * Tests for generate mode's scheduled Op → Forgejo Actions workflow YAML
 * synthesis (#927). Mirrors `./generate-pipeline.test.ts`'s style: same
 * trigger/job SHAPE as the github Op generator, plus proof the Forgejo
 * dialect is applied (runner label remapped) and that `permissions:` — a key
 * the Forgejo runner ignores — is dropped rather than emitted.
 */

import { describe, test, expect } from "vitest";
import { parseYAML } from "@intentius/chant/yaml";
import { generateForgejoOpPipeline } from "./generate-op-pipeline";
import { generateGithubOpPipeline } from "@intentius/chant-lexicon-github/components/generate-op-pipeline";
import type { ScheduledOpSpec } from "@intentius/chant/lexicon";

interface ParsedJob {
  "runs-on"?: string;
  outputs?: Record<string, string>;
  steps: Array<{ id?: string; uses?: string; run?: string }>;
}
interface ParsedDoc {
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
  jobs?: Record<string, ParsedJob>;
}
function parseFile(yaml: string): ParsedDoc {
  return parseYAML(yaml) as ParsedDoc;
}

describe("generateForgejoOpPipeline: structure (github-shaped)", () => {
  test("one file per scheduled Op, each a valid workflow with one job", () => {
    const specs: ScheduledOpSpec[] = [
      { name: "actions-audit", schedule: "0 6 * * *" },
      { name: "prod-reconcile", schedule: "0 * * * *", findingMode: "issue" },
    ];
    const result = generateForgejoOpPipeline(specs);

    expect(result.files).toHaveLength(2);
    expect(result.files.map((f) => f.name)).toEqual(["actions-audit.yml", "prod-reconcile.yml"]);

    const doc = parseFile(result.files[0].yaml);
    expect(doc.on).toEqual({ schedule: [{ cron: "0 6 * * *" }], workflow_dispatch: {} });
    expect(Object.keys(doc.jobs!)).toEqual(["actions-audit"]);
  });

  test("jobs/schedule/findingMode parity with the github generator (same input, same job list)", () => {
    const specs: ScheduledOpSpec[] = [{ name: "actions-audit", schedule: "0 6 * * *", findingMode: "pull-request" }];
    const fj = generateForgejoOpPipeline(specs);
    const gh = generateGithubOpPipeline(specs);
    expect(fj.jobs).toEqual(gh.jobs);
  });
});

describe("generateForgejoOpPipeline: dialect applied", () => {
  test("runner label ubuntu-latest is remapped to the Forgejo default (docker)", () => {
    const specs: ScheduledOpSpec[] = [{ name: "actions-audit", schedule: "0 6 * * *" }];
    const fjJob = parseFile(generateForgejoOpPipeline(specs).files[0].yaml).jobs!["actions-audit"];
    const ghJob = parseFile(generateGithubOpPipeline(specs).files[0].yaml).jobs!["actions-audit"];

    expect(fjJob["runs-on"]).toBe("docker");
    expect(ghJob["runs-on"]).toBe("ubuntu-latest");
  });

  test("permissions: is dropped — the Forgejo runner ignores it", () => {
    const specs: ScheduledOpSpec[] = [{ name: "prod-reconcile", schedule: "0 * * * *", findingMode: "pull-request" }];
    const fjYaml = generateForgejoOpPipeline(specs).files[0].yaml;
    const ghYaml = generateGithubOpPipeline(specs).files[0].yaml;

    expect(fjYaml).not.toMatch(/^permissions:/m);
    // The github counterpart, generated from the same spec, does declare it —
    // proving the omission is the dialect, not an accident of the spec.
    expect(ghYaml).toMatch(/^permissions:/m);
  });
});

describe("generateForgejoOpPipeline: non-cron trigger survives the dialect transform (#2084)", () => {
  test("a pull_request trigger round-trips through the Forgejo dialect, with permissions: still dropped", () => {
    const specs: ScheduledOpSpec[] = [
      { name: "tf-plan", trigger: { kind: "pull_request", branches: ["main"] }, findingMode: "issue" },
    ];
    const fj = generateForgejoOpPipeline(specs);
    const gh = generateGithubOpPipeline(specs);

    const fjDoc = parseFile(fj.files[0].yaml);
    const ghDoc = parseFile(gh.files[0].yaml);

    expect(fjDoc.on).toEqual({ pull_request: { branches: ["main"] } });
    expect(fjDoc.on).toEqual(ghDoc.on);
    expect(fj.jobs).toEqual(gh.jobs);
    expect(fj.jobs[0].trigger).toEqual({ kind: "pull_request", branches: ["main"] });

    expect(fj.files[0].yaml).not.toMatch(/^permissions:/m);
    expect(gh.files[0].yaml).toMatch(/^permissions:/m);
  });

  test("a push trigger round-trips through the Forgejo dialect, with permissions: still dropped", () => {
    const specs: ScheduledOpSpec[] = [{ name: "tf-apply", trigger: { kind: "push" } }];
    const fj = generateForgejoOpPipeline(specs);
    const ghDoc = parseFile(generateGithubOpPipeline(specs).files[0].yaml);
    const fjDoc = parseFile(fj.files[0].yaml);

    expect(fjDoc.on).toEqual({ push: { branches: ["main"] } });
    expect(fjDoc.on).toEqual(ghDoc.on);
    expect(fj.files[0].yaml).not.toMatch(/^permissions:/m);
  });
});

describe("generateForgejoOpPipeline: no comment finding mode (#2231)", () => {
  test("findingMode comment is refused by name, on the pull_request trigger it would otherwise fit", () => {
    // Forgejo Actions runs the same workflow shape and Forgejo's API is
    // GitHub-compatible, but the activity behind the mode shells to `gh`
    // against github.com and reads the GitHub Actions event payload. Nothing
    // in chant points either at a Forgejo instance, so the mode is refused
    // here rather than generating a job that fails at its Report step.
    const specs: ScheduledOpSpec[] = [
      { name: "app-plan", trigger: { kind: "pull_request", branches: ["main"] }, findingMode: "comment" },
    ];
    expect(() => generateForgejoOpPipeline(specs)).toThrow(
      /Scheduled Op "app-plan".*findingMode "comment".*no Forgejo API client/s,
    );
  });

  test("github generates the same spec, so the refusal is forgejo's and not the shared builder's", () => {
    const specs: ScheduledOpSpec[] = [
      { name: "app-plan", trigger: { kind: "pull_request", branches: ["main"] }, findingMode: "comment" },
    ];
    const gh = parseFile(generateGithubOpPipeline(specs).files[0].yaml);
    expect(gh.permissions).toEqual({ contents: "read", "pull-requests": "write" });
  });
});

/**
 * #2242 crosses the dialect asymmetrically: Forgejo runs `uses:` steps, so a
 * spec's `setup` list is emitted; it ignores `permissions:`, so an additive
 * scope is dropped with the rest of the section rather than emitted as a
 * control the runner never reads.
 */
describe("generateForgejoOpPipeline: setup steps and additive permissions (#2242)", () => {
  const OIDC_SPEC: ScheduledOpSpec = {
    name: "app-apply",
    trigger: { kind: "push", branches: ["main"] },
    setup: [
      {
        uses: "aws-actions/configure-aws-credentials@v6",
        with: { "role-to-assume": "${{ vars.AWS_ROLE_ARN }}", "aws-region": "eu-west-1" },
      },
    ],
    permissions: { "id-token": "write" },
  };

  test("emits the setup step after the checkout, with its `with:` intact", () => {
    const doc = parseFile(generateForgejoOpPipeline([OIDC_SPEC]).files[0].yaml);
    const steps = doc.jobs!["app-apply"].steps;
    // The checkout is rewritten to the Forgejo mirror; an action with no
    // mapping in ../actions.ts passes through verbatim.
    expect(steps[0].uses).toContain("actions/checkout@v4");
    expect(steps[1].uses).toBe("aws-actions/configure-aws-credentials@v6");
    expect((steps[1] as { with?: Record<string, string> }).with).toEqual({
      "role-to-assume": "${{ vars.AWS_ROLE_ARN }}",
      "aws-region": "eu-west-1",
    });
  });

  test("drops the additive permission along with the mode's own scopes", () => {
    const yaml = generateForgejoOpPipeline([OIDC_SPEC]).files[0].yaml;
    expect(yaml).not.toContain("permissions:");
    expect(yaml).not.toContain("id-token");
    // The same spec on github does carry it — this is a dialect drop, not a
    // generator that never computed the scope.
    expect(generateGithubOpPipeline([OIDC_SPEC]).files[0].yaml).toContain("id-token: write");
  });

  test("refuses an unpinned action ref on the same terms as github", () => {
    expect(() =>
      generateForgejoOpPipeline([{ ...OIDC_SPEC, setup: [{ uses: "aws-actions/configure-aws-credentials@main" }] }]),
    ).toThrow(/the action repository's own default branch/);
  });
});

describe("generateForgejoOpPipeline: the gated apply on push (#2243)", () => {
  const pushSpec: ScheduledOpSpec = { name: "app-apply", trigger: { kind: "push", branches: ["main"] } };

  test("the exit mapping crosses over: a gated apply is a green Forgejo run too", () => {
    // `--gated-exit 0` is `chant run`'s own, so it needs nothing from the
    // runner. `GITHUB_STEP_SUMMARY`, which the gate block goes to, is set by
    // Forgejo's act_runner the same way GitHub sets it.
    const doc = parseFile(generateForgejoOpPipeline([pushSpec]).files[0].yaml);
    const step = doc.jobs!["app-apply"].steps.find((s) => s.id === "chant-run");
    expect(step?.run).toContain("chant run app-apply --gated-exit 0 --json");
  });

  test("the notice job does not: it shells to `gh`, which no Forgejo runner points at its own instance", () => {
    const fj = parseFile(generateForgejoOpPipeline([pushSpec]).files[0].yaml);
    const gh = parseFile(generateGithubOpPipeline([pushSpec]).files[0].yaml);
    // Dropped the same way `permissions:` is dropped — by not being carried
    // onto the rebuilt doc — and github still has it, so the omission is
    // forgejo's rather than the shared builder's.
    expect(Object.keys(fj.jobs ?? {})).toEqual(["app-apply"]);
    expect(gh.jobs).toHaveProperty("app-apply-gate-notice");
  });
});
