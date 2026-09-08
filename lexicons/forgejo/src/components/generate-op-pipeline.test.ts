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
  environment?: Record<string, string>;
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

/**
 * chant #2257 — the option Forgejo has no concept for at all. Unlike
 * `permissions:`, which the runner reads and ignores, an environment is an
 * object that does not exist on a Forgejo instance: no protection rules, no
 * required reviewers, no wait timers. Emitting the key would read as a
 * deployment gate and hold nothing back, so it is dropped — and, because the
 * whole point of the option is a human holding an apply, the drop is said out
 * loud in the file rather than only in a build warning.
 */
describe("generateForgejoOpPipeline: a dropped deployment environment (#2257)", () => {
  const APPLY: ScheduledOpSpec = { name: "app-apply", trigger: { kind: "push", branches: ["main"] } };
  const GATED: ScheduledOpSpec = { ...APPLY, environment: { name: "production" } };

  /** The document a spec with no `environment` emitted before the option existed. */
  const AUDIT_YAML_BEFORE_2257 =
    [
      "on:",
      "  schedule:",
      "    - cron: '0 6 * * *'",
      "  workflow_dispatch: {}",
      "",
      "concurrency:",
      "  group: actions-audit",
      "  cancel-in-progress: false",
      "",
      "jobs:",
      "  actions-audit:",
      "    runs-on: docker",
      "    container: node:22-slim",
      "    steps:",
      "      - uses: https://code.forgejo.org/actions/checkout@v4",
      "      - run: chant run actions-audit",
      "        env:",
      "          GITHUB_TOKEN: '${{ github.token }}'",
      "          GH_TOKEN: '${{ github.token }}'",
    ].join("\n") + "\n";

  test("a spec with no environment emits the bytes it emitted before the option existed", () => {
    const yaml = generateForgejoOpPipeline([
      { name: "actions-audit", schedule: "0 6 * * *", findingMode: "issue" },
    ]).files[0].yaml;
    expect(yaml).toBe(AUDIT_YAML_BEFORE_2257);
  });

  test("drops the key, and github with the same spec keeps it", () => {
    const fj = parseFile(generateForgejoOpPipeline([GATED]).files[0].yaml);
    expect(fj.jobs!["app-apply"].environment).toBeUndefined();
    // A dialect drop, not a builder that never computed it.
    expect(generateGithubOpPipeline([GATED]).files[0].yaml).toContain("environment:");
  });

  test("says in the generated header which environment did not survive, and what still gates", () => {
    const yaml = generateForgejoOpPipeline([GATED]).files[0].yaml;
    expect(yaml.startsWith("# chant dropped `environment: production`")).toBe(true);
    expect(yaml).toContain("Forgejo Actions has no");
    expect(yaml).toContain("not held back by anything on the forge");
    // The gate that does survive is chant's own, which needs nothing from the forge.
    expect(yaml).toContain("chant/lifecycle");
    expect(yaml).toContain("approve <op> <gate>");
  });

  test("the header only appears for the Op that asked for an environment", () => {
    const files = generateForgejoOpPipeline([
      { ...GATED, name: "app-apply" },
      { name: "app-watch", schedule: "0 6 * * *" },
    ]).files;
    expect(files[0].yaml).toContain("# chant dropped `environment: production`");
    expect(files[1].yaml).not.toContain("# chant dropped");
    expect(files[1].yaml.startsWith("on:")).toBe(true);
  });

  test("refuses the same malformed environment github refuses, through the shared builder", () => {
    expect(() =>
      generateForgejoOpPipeline([{ ...APPLY, environment: { name: "production", url: "/deploys" } }]),
    ).toThrow(/neither an absolute http\(s\) URL nor a/);
  });
});
