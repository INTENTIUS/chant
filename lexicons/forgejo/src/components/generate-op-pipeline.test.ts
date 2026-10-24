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
import { ACTION_PINS, usesRef } from "@intentius/chant/action-pins";

interface ParsedJob {
  needs?: string;
  if?: string;
  permissions?: Record<string, string>;
  "runs-on"?: string;
  container?: string;
  environment?: Record<string, string>;
  outputs?: Record<string, string>;
  env?: Record<string, string>;
  steps: Array<{ id?: string; uses?: string; run?: string; shell?: string }>;
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

describe("generateForgejoOpPipeline: comment finding mode crosses over (#2291)", () => {
  // Used to be refused by name here (#2231), on the premise that chant had no
  // way to point `gh` at a Forgejo instance. Checked against a real Forgejo
  // 12.0.4+gitea-1.22.0 instance during INTENTIUS/choudoufu#1027 and found
  // false: Forgejo's own `/api/v1` takes the same GET/POST/PATCH calls
  // `reconcilePr`'s `postOrUpdateComment` makes, once it targets the right
  // URL. See `packages/core/src/op/activities/reconcile.test.ts` for the
  // mocked-transport proof of that fix; this file only proves the generator
  // no longer refuses the mode and produces the same job shape github does.
  test("findingMode comment generates cleanly on the pull_request trigger it needs", () => {
    const specs: ScheduledOpSpec[] = [
      { name: "app-plan", trigger: { kind: "pull_request", branches: ["main"] }, findingMode: "comment" },
    ];
    expect(() => generateForgejoOpPipeline(specs)).not.toThrow();
  });

  test("job/trigger/findingMode parity with the github generator (same input, same job list)", () => {
    const specs: ScheduledOpSpec[] = [
      { name: "app-plan", trigger: { kind: "pull_request", branches: ["main"] }, findingMode: "comment" },
    ];
    const fj = generateForgejoOpPipeline(specs);
    const gh = generateGithubOpPipeline(specs);
    expect(fj.jobs).toEqual(gh.jobs);
  });

  test("the run step carries GH_TOKEN/GITHUB_TOKEN, same as github's — permissions: still dropped by the dialect", () => {
    const specs: ScheduledOpSpec[] = [
      { name: "app-plan", trigger: { kind: "pull_request", branches: ["main"] }, findingMode: "comment" },
    ];
    const fjYaml = generateForgejoOpPipeline(specs).files[0].yaml;
    const ghDoc = parseFile(generateGithubOpPipeline(specs).files[0].yaml);

    expect(fjYaml).toContain("GH_TOKEN: '${{ github.token }}'");
    expect(fjYaml).toContain("GITHUB_TOKEN: '${{ github.token }}'");
    expect(fjYaml).not.toMatch(/^permissions:/m);
    // github still declares the scope the mode needs — proving the omission
    // above is the Forgejo dialect dropping `permissions:` wholesale, not a
    // sign the mode generated with no token.
    expect(ghDoc.permissions).toEqual({ contents: "read", "pull-requests": "write" });
  });
});

describe("generateForgejoOpPipeline: issue finding mode crosses over (#2351)", () => {
  // Refused here from #2332 to #2351: a real Forgejo instance answered 401 to
  // the writes `gh` made for this mode, because `gh` never sent its token to
  // a self-hosted host (#2315). #2333 fixed that credential, and #3757 moved
  // the mode onto the forge client in `pr-forge.ts`, which sends the header
  // itself. So the generator emits the mode as github does: same trigger,
  // same job, same step env, with `permissions:` dropped by the dialect.
  test("a cron issue Op generates cleanly", () => {
    const specs: ScheduledOpSpec[] = [{ name: "prod-watch", schedule: "0 6 * * *", findingMode: "issue" }];
    expect(() => generateForgejoOpPipeline(specs)).not.toThrow();
  });

  test("job/trigger/findingMode parity with the github generator", () => {
    const specs: ScheduledOpSpec[] = [
      { name: "prod-watch", schedule: "0 6 * * *", findingMode: "issue" },
      { name: "tf-plan", trigger: { kind: "pull_request", branches: ["main"] }, findingMode: "issue" },
    ];
    expect(generateForgejoOpPipeline(specs).jobs).toEqual(generateGithubOpPipeline(specs).jobs);
  });

  test("the cron job carries github.token as GH_TOKEN and GITHUB_TOKEN, the credential the mode reads", () => {
    const specs: ScheduledOpSpec[] = [{ name: "prod-watch", schedule: "0 6 * * *", findingMode: "issue" }];
    const fjDoc = parseFile(generateForgejoOpPipeline(specs).files[0].yaml);
    const ghDoc = parseFile(generateGithubOpPipeline(specs).files[0].yaml);
    const run = fjDoc.jobs!["prod-watch"].steps.at(-1)!;
    expect(run.run).toBe("chant run prod-watch");
    expect((run as { env?: Record<string, string> }).env).toEqual({
      GITHUB_TOKEN: "${{ github.token }}",
      GH_TOKEN: "${{ github.token }}",
    });
    expect(fjDoc.on).toEqual(ghDoc.on);
    expect(fjDoc.permissions).toBeUndefined();
    // github grants the scope the mode needs; on Forgejo what the token may
    // write is the runner's configuration.
    expect(ghDoc.permissions).toEqual({ contents: "read", issues: "write" });
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
    expect(steps[0].uses).toContain(`${usesRef(ACTION_PINS.checkout7)}`);
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

  test("the notice job crosses over too, posting through pr-forge rather than gh (#3773)", () => {
    const fj = parseFile(generateForgejoOpPipeline([pushSpec]).files[0].yaml);
    expect(Object.keys(fj.jobs ?? {})).toEqual(["app-apply", "app-apply-gate-notice"]);
    const notice = fj.jobs!["app-apply-gate-notice"];
    expect(notice.needs).toBe("app-apply");
    expect(notice.if).toBe("needs.app-apply.outputs.gated == 'true'");
    expect(notice.container).toBe("node:22");
    // The dialect drops the job's permissions like every scope but id-token.
    expect(notice.permissions).toBeUndefined();
    const script = notice.steps[0].run ?? "";
    expect(script).toContain('from "@intentius/chant/pr-forge"');
    expect(script).not.toMatch(/(^|\s)gh\s/m);
  });

  /**
   * chant #2299 — Forgejo Actions runs the same act_runner semantics as
   * GitHub Actions: a job with `container:` (which this generator's Op job
   * always carries, unconditionally) defaults to `sh`, and `sh` rejects `set
   * -o pipefail`. This generator reuses github's `buildGithubOpPipelineDocs`
   * to build the job, then the dialect transform in ../dialect.ts to cross
   * it, so the fix has to survive both: the exit-code capture is plain POSIX
   * `sh` (chant #2321 — no `shell: bash` to drop or rename in the first
   * place, unlike before #2321, when an unconditional `shell: bash` broke
   * any consumer image without bash — see the sibling test below).
   */
  test("the exit-code capture crosses the Forgejo dialect with no shell override — its job runs in a container, whose default shell is sh", () => {
    const doc = parseFile(generateForgejoOpPipeline([pushSpec]).files[0].yaml);
    const job = doc.jobs!["app-apply"];
    expect(job.container).toBe("node:22");
    const step = job.steps.find((s) => s.id === "chant-run");
    expect(step?.shell).toBeUndefined();
    expect(step?.run).not.toContain("pipefail");
    expect(step?.run).toContain('[ "$code" -eq 0 ] || exit "$code"');
  });

  /**
   * chant #2321 — same regression as the github generator's, since this one
   * reuses `buildGithubOpPipelineDocs` to build the job before crossing the
   * dialect: a consumer's non-bash `options.image` (alpine, distroless, …)
   * must not get an unconditional `shell: bash` it cannot run.
   */
  test("a consumer-set non-bash image's gated job can still start on Forgejo (#2321)", () => {
    const doc = parseFile(generateForgejoOpPipeline([pushSpec], { image: "alpine:3.20" }).files[0].yaml);
    const job = doc.jobs!["app-apply"];
    expect(job.container).toBe("alpine:3.20");
    const step = job.steps.find((s) => s.id === "chant-run");
    expect(step?.shell).toBeUndefined();
    expect(step?.run).not.toContain("pipefail");
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

  /**
   * The document a spec with no `environment` emitted before the option
   * existed. The `name:` line came later, from #2601, for every spec alike.
   */
  const AUDIT_YAML_BEFORE_2257 =
    [
      "name: actions-audit",
      "",
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
      "    container: node:22",
      "    steps:",
      `      - uses: https://code.forgejo.org/${usesRef(ACTION_PINS.checkout7)} # ${ACTION_PINS.checkout7.tag}`,
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
    expect(files[1].yaml.startsWith("name: app-watch\n\non:")).toBe(true);
  });

  test("the dropped-environment header comes first, then the workflow's name (#2601)", () => {
    const yaml = generateForgejoOpPipeline([GATED]).files[0].yaml;
    const lines = yaml.split("\n");
    const nameAt = lines.indexOf("name: app-apply");
    expect(nameAt).toBeGreaterThan(0);
    expect(lines.slice(0, nameAt - 1).every((line) => line.startsWith("# "))).toBe(true);
    expect(lines[nameAt + 2]).toBe("on:");
  });

  test("refuses the same malformed environment github refuses, through the shared builder", () => {
    expect(() =>
      generateForgejoOpPipeline([{ ...APPLY, environment: { name: "production", url: "/deploys" } }]),
    ).toThrow(/neither an absolute http\(s\) URL nor a/);
  });
});

/**
 * chant #2290 — per-Op credentials, so a pull-request job need not hold the
 * apply credential. The consuming project's own shape: `live-check` (no
 * `variables`) carries no credential while `live-apply` (`variables` set)
 * carries one, both generated from forge-wide `options.variables` that name
 * no credential at all.
 */
describe("generateForgejoOpPipeline: per-Op variables land on the job, not the workflow (#2290)", () => {
  const FORGE_WIDE = { CHANT_FORGE: "forgejo", AWS_REGION: "${{ vars.AWS_REGION }}" };
  const CREDENTIAL = { AWS_ACCESS_KEY_ID: "${{ secrets.AWS_ACCESS_KEY_ID }}" };

  test("a job whose spec declares no variables carries none, even when the forge-wide options do", () => {
    const doc = parseFile(
      generateForgejoOpPipeline([{ name: "live-check", trigger: { kind: "pull_request", branches: ["main"] } }], {
        variables: FORGE_WIDE,
      }).files[0].yaml,
    );
    expect(doc.jobs!["live-check"].env).toBeUndefined();
  });

  test("a job whose spec declares variables carries them as the job's own env:, beside the workflow env:", () => {
    const doc = parseFile(
      generateForgejoOpPipeline(
        [{ name: "live-apply", trigger: { kind: "push", branches: ["main"] }, variables: CREDENTIAL }],
        { variables: FORGE_WIDE },
      ).files[0].yaml,
    );
    expect(doc.jobs!["live-apply"].env).toEqual(CREDENTIAL);
  });

  /**
   * The proof the issue names: a generated workflow whose `live-check` job
   * carries no credential while its `live-apply` job does, from one forge-wide
   * options object that itself names no credential — the property the
   * consuming project (`examples/ci-pipelines`) needs to be able to state.
   */
  test("live-check carries no credential while live-apply does, from the same forge-wide options", () => {
    const files = generateForgejoOpPipeline(
      [
        { name: "live-check", trigger: { kind: "pull_request", branches: ["main"] } },
        { name: "live-apply", trigger: { kind: "push", branches: ["main"] }, variables: CREDENTIAL },
      ],
      { variables: FORGE_WIDE },
    ).files;
    const check = parseFile(files.find((f) => f.name === "live-check.yml")!.yaml);
    const apply = parseFile(files.find((f) => f.name === "live-apply.yml")!.yaml);

    expect(JSON.stringify(check.jobs!["live-check"])).not.toContain("AWS_ACCESS_KEY_ID");
    expect(apply.jobs!["live-apply"].env).toEqual(CREDENTIAL);
  });

  test("a per-Op key wins over a same-named forge-wide one — the job is more specific", () => {
    const doc = parseFile(
      generateForgejoOpPipeline(
        [
          {
            name: "live-apply",
            trigger: { kind: "push", branches: ["main"] },
            variables: { CHANT_FORGE: "overridden" },
          },
        ],
        { variables: FORGE_WIDE },
      ).files[0].yaml,
    );
    expect(doc.jobs!["live-apply"].env).toEqual({ CHANT_FORGE: "overridden" });
  });

  test("a spec declaring variables changes exactly the job's env: block and nothing else", () => {
    const spec: ScheduledOpSpec = { name: "live-apply", trigger: { kind: "push", branches: ["main"] } };
    const before = generateForgejoOpPipeline([spec]).files[0].yaml;
    const after = generateForgejoOpPipeline([{ ...spec, variables: CREDENTIAL }]).files[0].yaml;
    expect(after).toContain("    env:\n      AWS_ACCESS_KEY_ID: '${{ secrets.AWS_ACCESS_KEY_ID }}'\n");
    expect(
      after.replace("    env:\n      AWS_ACCESS_KEY_ID: '${{ secrets.AWS_ACCESS_KEY_ID }}'\n", ""),
    ).toBe(before);
  });
});

/**
 * chant #2294 dropped the gated-apply outputs on Forgejo while nothing read
 * them; #3773 brings back the notice job that does, and the outputs with it.
 */
describe("generateForgejoOpPipeline: the outputs the notice job reads (#2294, #3773)", () => {
  const pushSpec: ScheduledOpSpec = { name: "live-apply", trigger: { kind: "push", branches: ["main"] } };

  test("the push job publishes what it stopped on, as on github", () => {
    const doc = parseFile(generateForgejoOpPipeline([pushSpec]).files[0].yaml);
    expect(doc.jobs!["live-apply"].outputs).toEqual({
      gated: "${{ steps.chant-run.outputs.gated }}",
      op: "${{ steps.chant-run.outputs.op }}",
      gate: "${{ steps.chant-run.outputs.gate }}",
      approve: "${{ steps.chant-run.outputs.approve }}",
    });
    const step = doc.jobs!["live-apply"].steps.find((s) => s.id === "chant-run");
    expect(step?.run).toContain("GITHUB_OUTPUT");
    expect(step?.run).toContain("chant run live-apply --gated-exit 0 --json");
  });

  test("a non-push (cron) job carries no outputs and no gate script either way", () => {
    const doc = parseFile(
      generateForgejoOpPipeline([{ name: "live-discover", schedule: "0 6 * * *" }]).files[0].yaml,
    );
    expect(doc.jobs!["live-discover"].outputs).toBeUndefined();
    const step = doc.jobs!["live-discover"].steps.find((s) => typeof s.run === "string");
    expect(step?.run).not.toContain("node -e");
  });
});
