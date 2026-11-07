/** #4656: `chant release workflow` renders the release pipeline from the `release` block. */
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseYAML } from "../yaml";
import { renderReleaseWorkflow, RELEASE_DIGESTS_FILE, type ReleaseWorkflowInput } from "./release-workflow";
import type { SecurityGroup } from "./security";

const FIXTURES = join(__dirname, "__fixtures__", "release-workflow");
const FORGES = ["github", "forgejo", "gitlab"] as const;
const SECURE = new Set<SecurityGroup>(["supply-chain", "verified-releases"]);

describe("a config with only publish (#4656)", () => {
  test("renders, byte for byte, the file chant 0.124.70 wrote, on every forge, with and without the security groups and a workspace root", () => {
    for (const forge of FORGES) {
      for (const [name, groups] of [["plain", new Set<SecurityGroup>()], ["secure", SECURE]] as const) {
        for (const root of [".", "packages/app"]) {
          const file = `${forge}-${name}${root === "." ? "" : "-member"}.yml`;
          expect(renderReleaseWorkflow({ forge, groups, workspaceRoot: root }), file).toBe(readFileSync(join(FIXTURES, file), "utf-8"));
          // An empty block, or a tag trigger, is the same file.
          expect(renderReleaseWorkflow({ forge, groups, workspaceRoot: root, pipeline: { trigger: "tag" } }), file).toBe(readFileSync(join(FIXTURES, file), "utf-8"));
        }
      }
    }
  });
});

type GhJob = { needs?: string | string[]; outputs?: Record<string, string>; env?: Record<string, string>; steps: Array<{ id?: string; uses?: string; run?: string; with?: Record<string, unknown> }> };
type GhDoc = { on: Record<string, unknown>; env?: Record<string, string>; permissions: Record<string, string>; jobs: Record<string, GhJob> };
const runs = (job: GhJob): string[] => job.steps.filter((s) => s.run).map((s) => s.run!.trim());

const dispatch = (forge: (typeof FORGES)[number], over: Partial<ReleaseWorkflowInput> = {}): string =>
  renderReleaseWorkflow({ forge, groups: new Set(), pipeline: { trigger: "dispatch", build: "npm run build", after: ["npm run announce"] }, ...over });

describe("a dispatched release (#4656)", () => {
  for (const forge of ["github", "forgejo"] as const) {
    test(`${forge}: gate, cut, publish and post-release, started by hand with a label, and no tag before the gate`, () => {
      const doc = parseYAML(dispatch(forge)) as GhDoc;
      expect(Object.keys(doc.on)).toEqual(["workflow_dispatch"]);
      expect(doc.env).toEqual({ CHANT_RELEASE_LABEL: "${{ inputs.label }}" });
      expect(Object.keys(doc.jobs)).toEqual(["gate", "cut", "publish", "after-release"]);
      const { gate, cut, publish } = doc.jobs as Record<string, GhJob>;

      expect(gate!.outputs).toEqual({ commit: "${{ steps.green.outputs.commit }}" });
      const green = gate!.steps.find((s) => s.id === "green")!.run!;
      expect(green).toContain('npx chant ci last-green --from "$GITHUB_SHA" --json');
      expect(green).toContain('echo "commit=$commit" >> "$GITHUB_OUTPUT"');
      expect(green).not.toContain("is not green");
      // Nothing in the gate tags or cuts.
      expect(runs(gate!).join("\n")).not.toMatch(/release cut|git push|git tag/);

      expect(cut!.needs).toBe("gate");
      expect(cut!.env).toEqual({ CHANT_RELEASE_COMMIT: "${{ needs.gate.outputs.commit }}" });
      expect(cut!.steps[0]!.with).toEqual({ ref: "${{ needs.gate.outputs.commit }}", "fetch-depth": 0 });
      const cutRun = runs(cut!).join("\n");
      expect(cutRun).toContain(`npx chant release cut "$CHANT_RELEASE_LABEL" --at "$CHANT_RELEASE_COMMIT" --yes --build 'npm run build' --json > "$RUNNER_TEMP/chant-cut.json"`);
      expect(cutRun).toContain('git push origin "refs/tags/$tag"');
      // The label reaches the shell as a variable, never spliced into a run line.
      expect(dispatch(forge)).not.toMatch(/run:.*\$\{\{ inputs\.label \}\}/);

      expect(publish!.needs).toEqual(["gate", "cut"]);
      expect(runs(publish!)).toEqual([
        "npm ci",
        "git fetch origin 'refs/tags/ci/*:refs/tags/ci/*'",
        "git fetch origin chant/lifecycle:chant/lifecycle",
        "npm run build",
        'npx chant release publish "$CHANT_RELEASE_LABEL" --yes',
      ]);
      expect(runs(doc.jobs["after-release"]!)).toEqual(["npm ci", "npm run announce"]);
    });
  }

  test("gate head refuses a dispatched commit that is not green; a lane is passed to the gate and the cut", () => {
    const doc = parseYAML(renderReleaseWorkflow({ forge: "github", groups: new Set(), lane: "fast", pipeline: { trigger: "dispatch", gate: "head", build: false } })) as GhDoc;
    const green = doc.jobs.gate!.steps.find((s) => s.id === "green")!.run!;
    expect(green).toContain("--lane fast");
    expect(green).toContain('if [ "$commit" != "$GITHUB_SHA" ]');
    const cutRun = runs(doc.jobs.cut!).join("\n");
    expect(cutRun).toContain("--lane fast");
    expect(cutRun).not.toContain("--build");
    expect(runs(doc.jobs.publish!)).not.toContain("npm run build");
    expect(doc.jobs["after-release"]).toBeUndefined();
  });

  test("the security groups still add --require-provenance and release verify, and release images runs before the build", () => {
    const doc = parseYAML(dispatch("github", { groups: SECURE, images: true })) as GhDoc;
    expect(runs(doc.jobs.publish!)).toEqual([
      "npm ci",
      "git fetch origin 'refs/tags/ci/*:refs/tags/ci/*'",
      "git fetch origin chant/lifecycle:chant/lifecycle",
      `npx chant release images "$CHANT_RELEASE_LABEL" -o ${RELEASE_DIGESTS_FILE}`,
      `echo "CHANT_RELEASE_DIGESTS=$PWD/${RELEASE_DIGESTS_FILE}" >> "$GITHUB_ENV"`,
      "npm run build",
      'npx chant release verify "$CHANT_RELEASE_LABEL"',
      'npx chant release publish "$CHANT_RELEASE_LABEL" --require-provenance --yes',
    ]);
  });

  test("gitlab: four jobs chained by needs in the default stage, started with CHANT_RELEASE_LABEL, the commit handed on as a dotenv, pushes with CHANT_RELEASE_TOKEN", () => {
    const doc = parseYAML(dispatch("gitlab", { groups: SECURE, images: true })) as Record<string, { rules: Array<{ if: string }>; needs?: string[]; script: string[]; stage?: string; artifacts?: unknown; id_tokens?: unknown }>;
    expect(Object.keys(doc)).toEqual(["chant-release-gate", "chant-release-cut", "chant-release-publish", "chant-release-after"]);
    for (const job of Object.values(doc)) {
      expect(job.rules).toEqual([{ if: "$CHANT_RELEASE_LABEL && $CI_PIPELINE_SOURCE =~ /^(web|api|trigger)$/" }]);
      expect(job.stage).toBeUndefined();
    }
    expect(doc["chant-release-gate"]!.artifacts).toEqual({ reports: { dotenv: "chant-release-gate.env" } });
    expect(doc["chant-release-gate"]!.script.join("\n")).toContain('--from "$CI_COMMIT_SHA"');
    expect(doc["chant-release-cut"]!.needs).toEqual(["chant-release-gate"]);
    expect(doc["chant-release-cut"]!.script[0]).toBe('git checkout --detach "$CHANT_RELEASE_COMMIT"');
    expect(doc["chant-release-cut"]!.script.join("\n")).toContain("CHANT_RELEASE_TOKEN");
    const publish = doc["chant-release-publish"]!;
    expect(publish.id_tokens).toEqual({ SIGSTORE_ID_TOKEN: { aud: "sigstore" } });
    expect(publish.script.slice(-5)).toEqual([
      `npx chant release images "$CHANT_RELEASE_LABEL" -o ${RELEASE_DIGESTS_FILE}`,
      `export CHANT_RELEASE_DIGESTS="$PWD/${RELEASE_DIGESTS_FILE}"`,
      "npm run build",
      'npx chant release verify "$CHANT_RELEASE_LABEL"',
      'npx chant release publish "$CHANT_RELEASE_LABEL" --require-provenance --yes',
    ]);
    expect(doc["chant-release-after"]!.script.at(-1)).toBe("npm run announce");
  });

  test("a build command with a quote is passed to the cut as one shell word", () => {
    const text = renderReleaseWorkflow({ forge: "github", groups: new Set(), pipeline: { trigger: "dispatch", build: "npm run build -- --label 'x'" } });
    expect(text).toContain(`--build 'npm run build -- --label '\\''x'\\''' --json`);
  });
});

describe("the tag trigger with images or after (#4656)", () => {
  test("release images runs after the ledger fetch and before the build, and after-release follows the publish", () => {
    const doc = parseYAML(renderReleaseWorkflow({ forge: "github", groups: new Set(), images: true, pipeline: { after: ["./notify.sh"] } })) as GhDoc;
    expect(Object.keys(doc.on)).toEqual(["push"]);
    expect(runs(doc.jobs.publish!)).toEqual([
      "npm ci",
      "git fetch origin 'refs/tags/ci/*:refs/tags/ci/*'",
      "git fetch origin chant/lifecycle:chant/lifecycle",
      `npx chant release images "\${GITHUB_REF_NAME#release/}" -o ${RELEASE_DIGESTS_FILE}`,
      `echo "CHANT_RELEASE_DIGESTS=$PWD/${RELEASE_DIGESTS_FILE}" >> "$GITHUB_ENV"`,
      "npm run build",
      'npx chant release publish "${GITHUB_REF_NAME#release/}" --yes',
    ]);
    expect(doc.jobs["after-release"]!.needs).toBe("publish");
    expect(runs(doc.jobs["after-release"]!)).toEqual(['echo "CHANT_RELEASE_LABEL=${GITHUB_REF_NAME#release/}" >> "$GITHUB_ENV"', "npm ci", "./notify.sh"]);
  });

  test("gitlab: the after job needs the publish", () => {
    const doc = parseYAML(renderReleaseWorkflow({ forge: "gitlab", groups: new Set(), pipeline: { after: ["./notify.sh"] } })) as Record<string, { needs?: string[]; script: string[] }>;
    expect(doc["chant-release-after"]!.needs).toEqual(["chant-release-publish"]);
    expect(doc["chant-release-after"]!.script.at(-1)).toBe("./notify.sh");
  });
});
