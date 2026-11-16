/** #4656: `chant release workflow` renders the release pipeline from the `release` block. */
import { describe, expect, test, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseYAML } from "../yaml";
import { ACTION_PINS } from "../action-pins";
import { IMAGE_PINS } from "../image-pins";
import { TOOL_PINS } from "../tool-pins";
import type { CommandContext } from "../cli/registry";
import { GENERATED_OUT_ENV, GENERATED_ROOT_ENV } from "../generated-check";
import { NPM_TRUSTED_PUBLISHING_SETUP, releaseWorkflowHeader, renderReleaseWorkflow, runReleaseWorkflow, RELEASE_DIGESTS_PATHS, RELEASE_WORKFLOW_FILES, type ReleaseWorkflowInput, type ReleaseWorkflowTarget } from "./release-workflow";
import type { SecurityGroup } from "./security";
import { resolveTagTemplate, type MemberTags } from "../lifecycle/release-tag";

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
type GhDoc = { on: Record<string, unknown>; env?: Record<string, string>; permissions?: Record<string, string>; jobs: Record<string, GhJob> };
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
      'npx chant release images "$CHANT_RELEASE_LABEL" -o "$RUNNER_TEMP/chant-release-digests.json"',
      'echo "CHANT_RELEASE_DIGESTS=$RUNNER_TEMP/chant-release-digests.json" >> "$GITHUB_ENV"',
      "npm run build",
      'npx chant release verify "$CHANT_RELEASE_LABEL"',
      'npx chant release publish "$CHANT_RELEASE_LABEL" --require-provenance --yes',
    ]);
  });

  test("under release.version the publish job stamps the label before the images and the build, and the cut stamps on its own (#4840)", () => {
    const plain = parseYAML(dispatch("github", { groups: SECURE, images: true })) as GhDoc;
    const doc = parseYAML(dispatch("github", { groups: SECURE, images: true, version: true })) as GhDoc;
    const publish = runs(plain.jobs.publish!);
    const at = publish.indexOf('npx chant release images "$CHANT_RELEASE_LABEL" -o "$RUNNER_TEMP/chant-release-digests.json"');
    expect(runs(doc.jobs.publish!)).toEqual([...publish.slice(0, at), 'npx chant release stamp "$CHANT_RELEASE_LABEL"', ...publish.slice(at)]);
    expect(runs(doc.jobs.cut!)).toEqual(runs(plain.jobs.cut!));
    const gl = parseYAML(dispatch("gitlab", { images: true, version: true })) as Record<string, { script: string[] }>;
    const script = gl["chant-release-publish"]!.script;
    expect(script.indexOf('npx chant release stamp "$CHANT_RELEASE_LABEL"')).toBe(script.findIndex((l) => l.includes("release images")) - 1);
    for (const forge of FORGES) {
      const tagged = renderReleaseWorkflow({ forge, groups: new Set(), version: true });
      const stamp = tagged.indexOf("release stamp ");
      expect(stamp, forge).toBeGreaterThan(0);
      expect(stamp, forge).toBeLessThan(tagged.indexOf("npm run build"));
    }
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
      'npx chant release images "$CHANT_RELEASE_LABEL" -o "/tmp/chant-release-digests.json"',
      'export CHANT_RELEASE_DIGESTS="/tmp/chant-release-digests.json"',
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
      'npx chant release images "${GITHUB_REF_NAME#release/}" -o "$RUNNER_TEMP/chant-release-digests.json"',
      'echo "CHANT_RELEASE_DIGESTS=$RUNNER_TEMP/chant-release-digests.json" >> "$GITHUB_ENV"',
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

describe("the release workflow's permissions, env and setup (#4751)", () => {
  const pipeline = {
    trigger: "dispatch" as const,
    permissions: { packages: "write" as const },
    env: { OCI_USERNAME: "${{ github.actor }}", OCI_PASSWORD: "${{ github.token }}" },
    setup: [{ uses: "docker/setup-qemu-action@29109295f81e9208d7d86ff1c6c12d2833863392", with: { platforms: "arm64" } }, { run: "npm install -g npm@11.19.0" }],
  };

  test("github: the scope joins the workflow's, and the cut and publish jobs get the variables and the steps after the install", () => {
    const doc = parseYAML(renderReleaseWorkflow({ forge: "github", groups: new Set(), images: true, pipeline })) as GhDoc;
    expect(doc.permissions).toEqual({ contents: "write", "id-token": "write", packages: "write" });
    expect(doc.jobs.cut!.env).toEqual({ CHANT_RELEASE_COMMIT: "${{ needs.gate.outputs.commit }}", OCI_USERNAME: "${{ github.actor }}", OCI_PASSWORD: "${{ github.token }}" });
    expect(doc.jobs.publish!.env).toEqual({ OCI_USERNAME: "${{ github.actor }}", OCI_PASSWORD: "${{ github.token }}" });
    expect(doc.jobs.gate!.env).toBeUndefined();
    for (const job of [doc.jobs.cut!, doc.jobs.publish!]) {
      const i = job.steps.findIndex((s) => s.run === "npm ci");
      expect(job.steps[i + 1]).toEqual({ uses: "docker/setup-qemu-action@29109295f81e9208d7d86ff1c6c12d2833863392", with: { platforms: "arm64" } });
      expect(job.steps[i + 2]).toEqual({ run: "npm install -g npm@11.19.0" });
    }
    // An expression stays in env:, off every run: line.
    expect(runs(doc.jobs.publish!).join("\n")).not.toContain("github.token");
  });

  test("the tag trigger's publish job takes them too", () => {
    const doc = parseYAML(renderReleaseWorkflow({ forge: "github", groups: new Set(), pipeline: { ...pipeline, trigger: "tag" } })) as GhDoc;
    expect(doc.permissions!.packages).toBe("write");
    expect(doc.jobs.publish!.env).toEqual(pipeline.env);
    expect(doc.jobs.publish!.steps.some((s) => s.uses?.startsWith("docker/setup-qemu-action@"))).toBe(true);
  });

  test("gitlab: variables and run steps; permissions and an action are refused by name", () => {
    const gl = { trigger: "dispatch" as const, env: { OCI_USERNAME: "$CI_REGISTRY_USER" }, setup: [{ run: "docker run --privileged --rm tonistiigi/binfmt --install arm64" }] };
    const doc = parseYAML(renderReleaseWorkflow({ forge: "gitlab", groups: new Set(), pipeline: gl })) as Record<string, { variables: Record<string, string>; script: string[] }>;
    for (const name of ["chant-release-cut", "chant-release-publish"]) {
      expect(doc[name]!.variables).toEqual({ GIT_DEPTH: "0", OCI_USERNAME: "$CI_REGISTRY_USER" });
      expect(doc[name]!.script).toContain("docker run --privileged --rm tonistiigi/binfmt --install arm64");
    }
    expect(doc["chant-release-gate"]!.variables).toEqual({ GIT_DEPTH: "0" });
    expect(() => renderReleaseWorkflow({ forge: "gitlab", groups: new Set(), pipeline: { ...gl, permissions: { packages: "write" } } })).toThrow(/GitLab has no permissions/);
    expect(() => renderReleaseWorkflow({ forge: "gitlab", groups: new Set(), pipeline: { ...pipeline, permissions: undefined } })).toThrow(/give it as \{ run \}/);
  });

  test("a named setup step renders with its name on GitHub, and as its line on GitLab (#4932)", () => {
    const named = { trigger: "dispatch" as const, setup: [{ name: "QEMU for arm64", uses: "docker/setup-qemu-action@29109295f81e9208d7d86ff1c6c12d2833863392", with: { platforms: "arm64" } }, { name: "npm 11", run: "npm install -g npm@11.19.0" }] };
    const doc = parseYAML(renderReleaseWorkflow({ forge: "github", groups: new Set(), images: true, pipeline: named })) as GhDoc;
    const i = doc.jobs.cut!.steps.findIndex((s) => s.run === "npm ci");
    expect(doc.jobs.cut!.steps[i + 1]).toEqual({ name: "QEMU for arm64", uses: "docker/setup-qemu-action@29109295f81e9208d7d86ff1c6c12d2833863392", with: { platforms: "arm64" } });
    expect(doc.jobs.cut!.steps[i + 2]).toEqual({ name: "npm 11", run: "npm install -g npm@11.19.0" });
    const gl = parseYAML(renderReleaseWorkflow({ forge: "gitlab", groups: new Set(), pipeline: { trigger: "dispatch", setup: [{ name: "npm 11", run: "npm install -g npm@11.19.0" }] } })) as Record<string, { script: string[] }>;
    expect(gl["chant-release-cut"]!.script).toContain("npm install -g npm@11.19.0");
    expect(() => renderReleaseWorkflow({ forge: "github", groups: new Set(), pipeline: { setup: [{ name: "", run: "x" }] } })).toThrow(/name is blank/);
  });

  test("a scope already granted and a bad variable name are refused", () => {
    expect(() => renderReleaseWorkflow({ forge: "github", groups: new Set(), pipeline: { permissions: { contents: "read" } } })).toThrow(/already granted/);
    expect(() => renderReleaseWorkflow({ forge: "github", groups: new Set(), pipeline: { env: { "BAD-NAME": "x" } } })).toThrow(/not a variable name/);
  });
});

describe("the publish job hands GITHUB_TOKEN to a GitHub forge target (#4767)", () => {
  const ghForge = { type: "forge" as const, forge: "github" as const, repo: "acme/api", assets: ["dist/api.tar.gz"] };

  test("both triggers: the publish job gets the job's token, and no other job does", () => {
    for (const trigger of ["tag", "dispatch"] as const) {
      const doc = parseYAML(renderReleaseWorkflow({ forge: "github", groups: new Set(), publish: [ghForge], pipeline: { trigger } })) as GhDoc;
      expect(doc.jobs.publish!.env, trigger).toEqual({ GITHUB_TOKEN: "${{ github.token }}" });
      if (trigger === "dispatch") {
        // #5161: the cut job's release doctor checks the forge token too.
        expect(doc.jobs.cut!.env).toEqual({ CHANT_RELEASE_COMMIT: "${{ needs.gate.outputs.commit }}", GITHUB_TOKEN: "${{ github.token }}" });
        expect(doc.jobs.gate!.env).toBeUndefined();
        const off = parseYAML(renderReleaseWorkflow({ forge: "github", groups: new Set(), publish: [ghForge], pipeline: { trigger, doctor: false } })) as GhDoc;
        expect(off.jobs.cut!.env).toEqual({ CHANT_RELEASE_COMMIT: "${{ needs.gate.outputs.commit }}" });
      }
    }
  });

  test("it comes before release.workflow.env, which can set GITHUB_TOKEN itself", () => {
    const doc = parseYAML(renderReleaseWorkflow({ forge: "github", groups: new Set(), publish: [ghForge], pipeline: { env: { OCI_USERNAME: "${{ github.actor }}" } } })) as GhDoc;
    expect(Object.entries(doc.jobs.publish!.env!)).toEqual([["GITHUB_TOKEN", "${{ github.token }}"], ["OCI_USERNAME", "${{ github.actor }}"]]);
    const own = parseYAML(renderReleaseWorkflow({ forge: "github", groups: new Set(), publish: [ghForge], pipeline: { env: { GITHUB_TOKEN: "${{ secrets.RELEASE_TOKEN }}" } } })) as GhDoc;
    expect(own.jobs.publish!.env).toEqual({ GITHUB_TOKEN: "${{ secrets.RELEASE_TOKEN }}" });
  });

  test("a tokenEnv, another forge's target, or no forge target renders the file it did", () => {
    const plain = renderReleaseWorkflow({ forge: "github", groups: new Set() });
    expect(plain).toBe(readFileSync(join(FIXTURES, "github-plain.yml"), "utf-8"));
    for (const publish of [[{ ...ghForge, tokenEnv: "RELEASE_TOKEN" }], [{ ...ghForge, forge: "gitlab" as const }], []]) {
      expect(renderReleaseWorkflow({ forge: "github", groups: new Set(), publish }), JSON.stringify(publish)).toBe(plain);
    }
    // An npm target sets no GITHUB_TOKEN; it adds only the npm upgrade trusted publishing needs (#4786).
    const npmTarget = { type: "npm" as const, packages: ["."] };
    const npmOnly = renderReleaseWorkflow({ forge: "github", groups: new Set(), publish: [npmTarget] });
    expect(npmOnly).not.toContain("GITHUB_TOKEN");
    expect(npmOnly.split("\n").filter((l) => !plain.split("\n").includes(l))).toEqual([`      - run: ${JSON.stringify(NPM_TRUSTED_PUBLISHING_SETUP)}`]);
    // Forgejo's and GitLab's job tokens are not a GitHub token.
    for (const forge of ["forgejo", "gitlab"] as const) {
      expect(renderReleaseWorkflow({ forge, groups: new Set(), publish: [ghForge] })).toBe(readFileSync(join(FIXTURES, `${forge}-plain.yml`), "utf-8"));
    }
  });
});

describe("a repository's first dispatched release (terragucci 0.4.50's cut)", () => {
  const cutLedgerLine = (): string => {
    const doc = parseYAML(renderReleaseWorkflow({ forge: "github", groups: new Set(), pipeline: { trigger: "dispatch" } })) as GhDoc;
    const line = runs(doc.jobs.cut!).find((r) => r.includes("chant/lifecycle"));
    expect(line).toBeDefined();
    return line!;
  };
  const sh = (cmd: string, cwd: string) => spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf8" });

  test("the cut goes on when the remote has no chant/lifecycle yet, fetches it when it has one, and stops when the remote can't be read", () => {
    const root = mkdtempSync(join(tmpdir(), "chant-first-ledger-"));
    const origin = join(root, "origin.git");
    const clone = join(root, "clone");
    sh(`git init -q --bare -b main ${origin} && git clone -q ${origin} ${clone} && cd ${clone} && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init && git push -q origin main`, root);
    const line = cutLedgerLine();

    const first = sh(line, clone);
    expect(first.status, first.stderr).toBe(0);
    expect(sh("git rev-parse --verify -q refs/heads/chant/lifecycle", clone).status).not.toBe(0);

    sh(`git push -q origin main:refs/heads/chant/lifecycle`, clone);
    expect(sh(line, clone).status).toBe(0);
    expect(sh("git rev-parse --verify -q refs/heads/chant/lifecycle", clone).status).toBe(0);

    sh(`git remote set-url origin ${join(root, "gone.git")}`, clone);
    expect(sh(line, clone).status).not.toBe(0);
  });
});

describe("the cut hands its image archives to the publish job (#4657)", () => {
  const archives = ["dist/images/tofu.tar", "dist/images/terraform.tar"];
  type Step = { uses?: string; run?: string; with?: Record<string, unknown> };
  const steps = (forge: "github" | "forgejo", root?: string) => {
    const doc = parseYAML(renderReleaseWorkflow({ forge, groups: new Set(), images: true, imageArchives: archives, ...(root ? { workspaceRoot: root } : {}), pipeline: { trigger: "dispatch", build: "npm run build" } })) as { jobs: Record<string, { steps: Step[] }> };
    return { cut: doc.jobs.cut!.steps, publish: doc.jobs.publish!.steps };
  };

  test("GitHub: the cut uploads the archives, the publish job downloads them and checks them without building", () => {
    const { cut, publish } = steps("github");
    const up = cut.at(-1)!;
    expect(up.uses).toMatch(/^actions\/upload-artifact@/);
    expect(up.with).toMatchObject({ name: "chant-release-images", "if-no-files-found": "error", "retention-days": 1 });
    expect(String(up.with!.path).trim().split("\n")).toEqual(archives);
    const down = publish.findIndex((s) => s.uses?.startsWith("actions/download-artifact@"));
    const check = publish.findIndex((s) => s.run?.includes("release images"));
    expect(down).toBeGreaterThan(-1);
    expect(publish[down]!.with).toEqual({ name: "chant-release-images", path: "dist/images" });
    expect(check).toBeGreaterThan(down);
    expect(publish[check]!.run).toBe('npx chant release images "$CHANT_RELEASE_LABEL" --no-build -o "$RUNNER_TEMP/chant-release-digests.json"');
  });

  test("Forgejo takes v3 of the artifact actions, and a workspace root prefixes the paths", () => {
    const { cut, publish } = steps("forgejo", "packages/app");
    expect(cut.at(-1)!.uses).toContain(ACTION_PINS.uploadArtifact3.sha);
    expect(String(cut.at(-1)!.with!.path)).toContain("packages/app/dist/images/tofu.tar");
    expect(publish.find((s) => s.uses?.includes("download-artifact"))!.uses).toContain(ACTION_PINS.downloadArtifact3.sha);
    expect(publish.find((s) => s.uses?.includes("download-artifact"))!.with!.path).toBe("packages/app/dist/images");
  });

  test("GitLab: the cut keeps the archives as artifacts the publish job needs, and checks them without building", () => {
    const doc = parseYAML(renderReleaseWorkflow({ forge: "gitlab", groups: new Set(), images: true, imageArchives: archives, pipeline: { trigger: "dispatch" } })) as Record<string, { artifacts?: unknown; script: string[] }>;
    expect(doc["chant-release-cut"]!.artifacts).toEqual({ paths: archives, expire_in: "1 day" });
    expect(doc["chant-release-publish"]!.script).toContain('npx chant release images "$CHANT_RELEASE_LABEL" --no-build -o "/tmp/chant-release-digests.json"');
  });

  test("without the archive paths the publish job builds the images again, as before", () => {
    const doc = parseYAML(renderReleaseWorkflow({ forge: "github", groups: new Set(), images: true, pipeline: { trigger: "dispatch" } })) as { jobs: Record<string, { steps: Step[] }> };
    expect(doc.jobs.publish!.steps.some((s) => s.uses?.includes("download-artifact"))).toBe(false);
    expect(doc.jobs.publish!.steps.find((s) => s.run?.includes("release images"))!.run).not.toContain("--no-build");
  });
});

describe("the publish job leaves the checkout as the cut left it (#4853)", () => {
  // `chant release publish` refuses a dirty tree, and a repository that commits
  // files under .chant/ can't ignore the directory, so no step the generator
  // writes may put the digests in the checkout.
  const lines = (doc: unknown): string[] =>
    typeof doc === "string" ? doc.split("\n") : Array.isArray(doc) ? doc.flatMap(lines) : doc && typeof doc === "object" ? Object.values(doc).flatMap(lines) : [];
  test("on every forge and trigger, the digests go to the runner's temp directory and CHANT_RELEASE_DIGESTS names that file", () => {
    for (const forge of FORGES) {
      for (const trigger of ["tag", "dispatch"] as const) {
        for (const root of [".", "packages/app"]) {
          const all = lines(parseYAML(renderReleaseWorkflow({ forge, groups: SECURE, images: true, imageArchives: ["dist/app.tar"], workspaceRoot: root, pipeline: { trigger } })));
          const where = `${forge} ${trigger} ${root}`;
          const images = all.filter((l) => l.includes("release images "));
          expect(images.length, where).toBe(1);
          expect(images[0], where).toMatch(new RegExp(` -o "${RELEASE_DIGESTS_PATHS[forge].replace(/[$.]/g, "\\$&")}"$`));
          const env = all.filter((l) => l.includes("CHANT_RELEASE_DIGESTS="));
          expect(env, where).toEqual([forge === "gitlab" ? `export CHANT_RELEASE_DIGESTS="${RELEASE_DIGESTS_PATHS.gitlab}"` : `echo "CHANT_RELEASE_DIGESTS=${RELEASE_DIGESTS_PATHS[forge]}" >> "$GITHUB_ENV"`]);
          expect(all.join("\n"), where).not.toContain(".chant/");
        }
      }
    }
  });
});

describe("the gate stops when the green commit's workflow files differ from the dispatched one's (#4852)", () => {
  // The gate's shell, run in a scratch repository, with a chant that answers
  // `ci last-green` with `green`. GitHub refuses the job's token a tag on a
  // commit whose workflow files differ from the default branch's, so the gate
  // stops before the cut builds anything.
  function gate(over: Partial<ReleaseWorkflowInput> = {}) {
    const dir = mkdtempSync(join(tmpdir(), "chant-4852-"));
    const git = (...args: string[]) => {
      const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf-8" });
      if (r.status !== 0) throw new Error(r.stderr);
      return r.stdout.trim();
    };
    git("init", "-q", "-b", "main");
    const commit = (files: Record<string, string>, msg: string) => {
      for (const [f, t] of Object.entries(files)) {
        spawnSync("mkdir", ["-p", join(dir, f, "..")]);
        spawnSync("sh", ["-c", `printf '%s' "$1" > "$2"`, "sh", t, join(dir, f)]);
      }
      git("add", "-A");
      git("commit", "-q", "-m", msg);
      return git("rev-parse", "HEAD");
    };
    const green = commit({ ".github/workflows/chant-release.yml": "v1\n", "src/a.ts": "1\n" }, "green");
    const stub = join(dir, "..", `${dir.split("/").pop()}-chant`);
    spawnSync("sh", ["-c", `printf '#!/bin/sh\\necho "{\\\\"commit\\\\":{\\\\"sha\\\\":\\\\"%s\\\\"}}"\\n' "$1" > "$2" && chmod +x "$2"`, "sh", green, stub]);
    const doc = parseYAML(renderReleaseWorkflow({ forge: "github", groups: new Set(), pipeline: { trigger: "dispatch", chant: stub }, ...over })) as GhDoc;
    const script = doc.jobs.gate!.steps.find((s) => s.id === "green")!.run!;
    const run = (sha: string) => {
      const out = join(dir, ".gh-output");
      const r = spawnSync("bash", ["-e", "-c", script], { cwd: dir, encoding: "utf-8", env: { ...process.env, GITHUB_SHA: sha, GITHUB_OUTPUT: out } });
      return { status: r.status, stderr: r.stderr, output: spawnSync("cat", [out], { encoding: "utf-8" }).stdout };
    };
    return { commit, run, green };
  }

  test("a commit after the green one that changed only code: the gate hands on the green commit", () => {
    const { commit, run, green } = gate();
    const head = commit({ "src/a.ts": "2\n" }, "code");
    const r = run(head);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.output).toBe(`commit=${green}\n`);
  });

  test("a commit after the green one changed .github/workflows: the gate stops and names it", () => {
    const { commit, run, green } = gate();
    const changed = commit({ ".github/workflows/chant-release.yml": "v2\n" }, "workflows");
    const head = commit({ "src/a.ts": "2\n" }, "code");
    const r = run(head);
    expect(r.status).toBe(1);
    expect(r.output).toBe("");
    expect(r.stderr).toContain(`the newest green commit, ${green}, has other workflow files than ${head}, and GitHub refuses this job's token a tag on it, so no release is cut. Dispatch again once ${changed}, which changed .github/workflows, or a commit after it is green.`);
  });

  test("forgejo and gitlab render no such check, and neither does gate: head", () => {
    for (const forge of ["forgejo", "gitlab"] as const) expect(dispatch(forge)).not.toContain(".github/workflows");
    expect(dispatch("github", { pipeline: { trigger: "dispatch", gate: "head" } })).not.toContain(":(top).github/workflows");
    expect(dispatch("github")).toContain(":(top).github/workflows");
  });
});

describe("GHCR credentials and npm trusted publishing from the targets (#4786)", () => {
  const ghcr: ReleaseWorkflowTarget = { type: "oci", repository: "ghcr.io/acme/app" };
  const npm: ReleaseWorkflowTarget = { type: "npm" };
  const qemu = { uses: "docker/setup-qemu-action@99012661954931238ded8c8b007157a8430204e1 # v4.4.0", with: { platforms: "arm64" } };
  const render = (publish: ReleaseWorkflowTarget[], pipeline: ReleaseWorkflowInput["pipeline"] = {}, forge: (typeof FORGES)[number] = "github") =>
    renderReleaseWorkflow({ forge, groups: new Set(), images: true, imageArchives: ["dist/app.tar"], publish, pipeline: { trigger: "dispatch", ...pipeline } });

  test("an oci target on ghcr.io with no credentials named: packages: write, and the job token as OCI_USERNAME and OCI_PASSWORD in the cut and the publish", () => {
    const doc = parseYAML(render([ghcr])) as GhDoc;
    expect(doc.permissions).toEqual({ contents: "write", "id-token": "write", packages: "write" });
    for (const job of ["cut", "publish"]) {
      expect(doc.jobs[job]!.env, job).toMatchObject({ OCI_USERNAME: "${{ github.actor }}", OCI_PASSWORD: "${{ github.token }}" });
    }
    expect(runs(doc.jobs.publish!)).not.toContain(NPM_TRUSTED_PUBLISHING_SETUP);
  });

  test("an npm target on npmjs: the cut and the publish upgrade npm after the install when the runner's is older than trusted publishing needs", () => {
    const doc = parseYAML(render([npm])) as GhDoc;
    expect(doc.permissions).toEqual({ contents: "write", "id-token": "write" });
    for (const job of ["cut", "publish"]) {
      const r = runs(doc.jobs[job]!);
      expect(r[r.indexOf("npm ci") + 1], job).toBe(NPM_TRUSTED_PUBLISHING_SETUP);
      expect(doc.jobs[job]!.env?.OCI_PASSWORD, job).toBeUndefined();
    }
    expect(NPM_TRUSTED_PUBLISHING_SETUP).toContain('"11.5.1"');
  });

  test("a config that wired them by hand renders the same file once it drops them", () => {
    const byHand = render([ghcr, npm], {
      permissions: { packages: "write" },
      env: { OCI_USERNAME: "${{ github.actor }}", OCI_PASSWORD: "${{ github.token }}" },
      setup: [qemu, { run: NPM_TRUSTED_PUBLISHING_SETUP }],
    });
    expect(render([ghcr, npm], { setup: [qemu] })).toBe(byHand);
  });

  test("the config wins: its own credentials, scope or registry, other forges, and a config with neither target render as before", () => {
    const plain = render([]);
    expect(render([{ type: "oci", repository: "docker.io/acme/app" }])).toBe(plain);
    expect(render([{ ...ghcr, usernameEnv: "GHCR_USER", passwordEnv: "GHCR_TOKEN" }])).toBe(plain);
    expect(render([{ type: "npm", registry: "https://npm.pkg.github.com" }])).toBe(plain);
    for (const forge of ["forgejo", "gitlab"] as const) expect(render([ghcr, npm], {}, forge), forge).toBe(render([], {}, forge));
    const own = parseYAML(render([ghcr], { env: { OCI_PASSWORD: "${{ secrets.GHCR }}" } })) as GhDoc;
    expect(own.jobs.publish!.env).toMatchObject({ OCI_USERNAME: "${{ github.actor }}", OCI_PASSWORD: "${{ secrets.GHCR }}" });
    // A tag-triggered workflow reads the targets the same way.
    const tagged = parseYAML(renderReleaseWorkflow({ forge: "github", groups: new Set(), publish: [ghcr, npm] })) as GhDoc;
    expect(tagged.permissions?.packages).toBe("write");
    expect(runs(tagged.jobs.publish!)).toContain(NPM_TRUSTED_PUBLISHING_SETUP);
  });
});

describe("QEMU for the platforms release.images builds (#4876)", () => {
  type Step = { uses?: string; run?: string; with?: Record<string, unknown> };
  const TWO = ["linux/amd64", "linux/arm64"];
  const render = (forge: (typeof FORGES)[number], imagePlatforms: string[], pipeline: ReleaseWorkflowInput["pipeline"] = {}, trigger: "dispatch" | "tag" = "dispatch") =>
    renderReleaseWorkflow({ forge, groups: new Set(), images: true, imageArchives: ["dist/images/app.tar"], imagePlatforms, pipeline: { ...(trigger === "dispatch" ? { trigger } : {}), ...pipeline } });
  const ghSteps = (yaml: string, job: string): Step[] => (parseYAML(yaml) as { jobs: Record<string, { steps: Step[] }> }).jobs[job]!.steps;

  test("a two-platform release.images: the cut and the publish set up QEMU for arm64 after the install, before the config's setup, on GitHub and Forgejo", () => {
    for (const forge of ["github", "forgejo"] as const) {
      const yaml = render(forge, TWO, { setup: [{ run: "echo own" }] });
      for (const job of ["cut", "publish"]) {
        const steps = ghSteps(yaml, job);
        const at = steps.findIndex((s) => s.uses?.startsWith("docker/setup-qemu-action@"));
        expect(steps[at], `${forge} ${job}`).toEqual({ uses: `docker/setup-qemu-action@${ACTION_PINS.dockerSetupQemu4.sha}`, with: { platforms: "arm64" } });
        expect(steps[at - 1]!.run, `${forge} ${job}`).toBe("npm ci");
        expect(steps[at + 1]!.run, `${forge} ${job}`).toBe("echo own");
      }
      expect(yaml).toContain(`docker/setup-qemu-action@${ACTION_PINS.dockerSetupQemu4.sha} # v4.4.0`);
      // The tag-triggered publish job builds the images too.
      expect(ghSteps(render(forge, TWO, {}, "tag"), "publish").some((s) => s.uses?.startsWith("docker/setup-qemu-action@")), forge).toBe(true);
    }
  });

  test("on GitLab, a binfmt run line in the cut and the publish, the image pinned by digest (#4941)", () => {
    const doc = parseYAML(render("gitlab", TWO)) as Record<string, { script: string[] }>;
    for (const job of ["chant-release-cut", "chant-release-publish"]) {
      const script = doc[job]!.script;
      expect(script[script.indexOf("npm ci") + 1], job).toBe(`docker run --privileged --rm tonistiigi/binfmt:${IMAGE_PINS.binfmt.tag}@${IMAGE_PINS.binfmt.digest} --install arm64`);
      expect(IMAGE_PINS.binfmt.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  test("a one-platform release.images, or none, renders no QEMU on any forge", () => {
    for (const forge of FORGES) {
      for (const platforms of [["linux/amd64"], []]) {
        const yaml = render(forge, platforms);
        expect(yaml, forge).not.toContain("setup-qemu-action");
        expect(yaml, forge).not.toContain("binfmt");
      }
    }
    // A config with no release.images builds nothing, whatever the platforms.
    expect(renderReleaseWorkflow({ forge: "github", groups: new Set(), imagePlatforms: TWO, pipeline: { trigger: "dispatch" } })).not.toContain("setup-qemu-action");
  });

  test("a config that names the step itself renders as today, and drops it to the same file", () => {
    const qemu = { uses: `docker/setup-qemu-action@${ACTION_PINS.dockerSetupQemu4.sha} # v4.4.0`, with: { platforms: "arm64" } };
    const own = { run: 'echo "npm"' };
    const byHand = render("github", TWO, { setup: [qemu, own] });
    expect(byHand).toBe(render("github", [], { setup: [qemu, own] }));
    expect(render("github", TWO, { setup: [own] })).toBe(byHand);
    const binfmt = { run: "docker run --privileged --rm tonistiigi/binfmt --install arm64" };
    expect(render("gitlab", TWO, { setup: [binfmt] })).toBe(render("gitlab", [], { setup: [binfmt] }));
  });

  test("other architectures go in as QEMU names them", () => {
    const steps = ghSteps(render("github", ["linux/amd64", "linux/arm/v7", "linux/riscv64", "linux/arm64"]), "cut");
    expect(steps.find((s) => s.uses?.startsWith("docker/setup-qemu-action@"))!.with).toEqual({ platforms: "arm,arm64,riscv64" });
  });
});

describe("chant release workflow under chant dev generated-check (#4950)", () => {
  test("writes into the render tree with no --output, names no --output in the header, and leaves the committed file", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-4950-release-")));
    const out = realpathSync(mkdtempSync(join(tmpdir(), "chant-4950-release-out-")));
    writeFileSync(join(root, "chant.workspace.json"), JSON.stringify({ name: "product", schema: 1, members: [] }));
    writeFileSync(join(root, "chant.config.json"), JSON.stringify({ lexicons: [] }));
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    writeFileSync(join(root, RELEASE_WORKFLOW_FILES.github), "committed\n");
    expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    process.env[GENERATED_OUT_ENV] = out;
    process.env[GENERATED_ROOT_ENV] = root;
    try {
      expect(await runReleaseWorkflow({ args: { forge: "github" } } as unknown as CommandContext)).toBe(0);
      expect(readFileSync(join(root, RELEASE_WORKFLOW_FILES.github), "utf-8")).toBe("committed\n");
      const rendered = readFileSync(join(out, RELEASE_WORKFLOW_FILES.github), "utf-8");
      expect(rendered.split("\n")[0]).toBe(releaseWorkflowHeader("chant release workflow --forge github").trimEnd());
    } finally {
      delete process.env[GENERATED_OUT_ENV];
      delete process.env[GENERATED_ROOT_ENV];
      cwd.mockRestore();
      log.mockRestore();
    }
  });
});

describe("release-only adoption (#5149)", () => {
  test("forge-checks: the gate names the dispatched commit, and the cut gets the run's token and checks: read and statuses: read", () => {
    const doc = parseYAML(dispatch("github", { green: "forge-checks" })) as GhDoc;
    const green = doc.jobs.gate!.steps.find((s) => s.id === "green")!.run!;
    expect(green).toContain('commit="$GITHUB_SHA"');
    expect(green).not.toContain("ci last-green");
    expect(doc.permissions).toEqual({ contents: "write", "id-token": "write", checks: "read", statuses: "read" });
    expect(doc.jobs.cut!.env).toEqual({ CHANT_RELEASE_COMMIT: "${{ needs.gate.outputs.commit }}", GITHUB_TOKEN: "${{ github.token }}" });
  });

  test("none: the gate names the dispatched commit and no scope or token is added; the chant gate renders as before", () => {
    const none = parseYAML(dispatch("github", { green: "none" })) as GhDoc;
    expect(none.jobs.gate!.steps.find((s) => s.id === "green")!.run!).not.toContain("ci last-green");
    expect(none.permissions).toEqual({ contents: "write", "id-token": "write" });
    expect(none.jobs.cut!.env).toEqual({ CHANT_RELEASE_COMMIT: "${{ needs.gate.outputs.commit }}" });
    expect(dispatch("github", { green: "chant" })).toBe(dispatch("github"));
  });

  test("GitLab forge-checks: the cut reads the pipelines with the release token", () => {
    const doc = parseYAML(dispatch("gitlab", { green: "forge-checks" })) as Record<string, { script: string[] }>;
    expect(doc["chant-release-gate"]!.script).toContain('commit="$CI_COMMIT_SHA"');
    expect(doc["chant-release-cut"]!.script).toContain('export CHANT_GITLAB_TOKEN="${CHANT_GITLAB_TOKEN:-$CHANT_RELEASE_TOKEN}"');
  });

  test("a project with only package.json and chant.config.ts renders its workflow with no chant.workspace.json, gated on the forge's checks", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-5149-release-")));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "acme-cli", version: "0.0.0" }));
    writeFileSync(join(root, "chant.config.ts"), `export default { release: { workflow: { trigger: "dispatch" }, publish: [{ type: "npm", packages: ["."] }] } };\n`);
    expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await runReleaseWorkflow({ args: { forge: "github", output: join(root, "release.yml") } } as unknown as CommandContext)).toBe(0);
      const doc = parseYAML(readFileSync(join(root, "release.yml"), "utf-8")) as GhDoc;
      expect(doc.jobs.gate!.steps.find((s) => s.id === "green")!.run!).toContain('commit="$GITHUB_SHA"');
      expect(doc.permissions?.checks).toBe("read");
      expect(runs(doc.jobs.publish!)).toContain('npx chant release publish "$CHANT_RELEASE_LABEL" --yes');
      // #5161: the doctor checks the artifact release's targets before the cut.
      expect(runs(doc.jobs.cut!).some((r) => r.endsWith(" release doctor"))).toBe(true);
      // No build script in package.json, so no build step that would fail.
      expect(runs(doc.jobs.publish!)).not.toContain("npm run build");
    } finally {
      cwd.mockRestore();
      log.mockRestore();
    }
  });
});

describe("toolchains and per-platform builds (#5152)", () => {
  const steps = (job: GhJob) => job.steps.filter((s) => s.uses).map((s) => ({ uses: s.uses!.split("@")[0], with: s.with }));

  test("a Go project with no package.json: the jobs that build set up Go from go.mod with no cache, beside the Node chant runs on, and nothing runs npm", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "chant-5152-go-")));
    writeFileSync(join(root, "go.mod"), "module example.com/acme\n\ngo 1.24\n");
    writeFileSync(join(root, "chant.config.ts"), `export default { release: { workflow: { trigger: "dispatch" }, publish: [{ type: "forge", forge: "github", repo: "acme/acme", assets: ["dist/acme"] }] } };\n`);
    expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0);
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await runReleaseWorkflow({ args: { forge: "github", output: join(root, "release.yml") } } as unknown as CommandContext)).toBe(0);
      const text = readFileSync(join(root, "release.yml"), "utf-8");
      const doc = parseYAML(text) as GhDoc;
      expect(steps(doc.jobs.gate!).map((s) => s.uses)).toEqual(["actions/checkout", "actions/setup-node"]);
      for (const job of ["cut", "publish"]) {
        expect(steps(doc.jobs[job]!).slice(0, 3)).toEqual([
          { uses: "actions/checkout", with: { ref: "${{ needs.gate.outputs.commit }}", "fetch-depth": 0 } },
          { uses: "actions/setup-node", with: { "node-version": 24, "registry-url": "https://registry.npmjs.org" } },
          { uses: "actions/setup-go", with: { "go-version-file": "go.mod", cache: false } },
        ]);
      }
      expect(text).not.toMatch(/npm ci|npm run build/);
      expect(runs(doc.jobs.publish!).at(-1)).toMatch(/^npx --yes @intentius\/chant@\d+\.\d+\.\d+\S* release publish "\$CHANT_RELEASE_LABEL" --yes$/);
      expect(text).toContain(`actions/setup-go@${ACTION_PINS.setupGo7.sha} # ${ACTION_PINS.setupGo7.tag}`);
    } finally {
      cwd.mockRestore();
      log.mockRestore();
    }
  });

  test("declared toolchains with versions, each pinned; files name the version when none is declared; a member root prefixes the version files", () => {
    const doc = parseYAML(dispatch("github", { pipeline: { trigger: "dispatch", toolchains: [{ name: "python", version: "3.12" }, "rust", "java", { name: "node", version: "22" }] } })) as GhDoc;
    expect(steps(doc.jobs.cut!).slice(1)).toEqual([
      { uses: "actions/setup-node", with: { "node-version": 22, "registry-url": "https://registry.npmjs.org" } },
      { uses: "actions/setup-python", with: { "python-version": "3.12" } },
      { uses: "actions-rust-lang/setup-rust-toolchain", with: { cache: false, rustflags: "" } },
      { uses: "actions/setup-java", with: { distribution: "temurin", "java-version": "21" } },
    ]);
    // The gate runs chant only: Node at the declared version.
    expect(steps(doc.jobs.gate!).slice(1)).toEqual([{ uses: "actions/setup-node", with: { "node-version": 22, "registry-url": "https://registry.npmjs.org" } }]);
    const found = parseYAML(dispatch("github", { workspaceRoot: "tools/cli", projectFiles: ["pyproject.toml", ".python-version", "pom.xml", ".java-version"] })) as GhDoc;
    expect(steps(found.jobs.publish!).slice(1)).toEqual([
      { uses: "actions/setup-node", with: { "node-version": 24, "registry-url": "https://registry.npmjs.org" } },
      { uses: "actions/setup-python", with: { "python-version-file": "tools/cli/.python-version" } },
      { uses: "actions/setup-java", with: { distribution: "temurin", "java-version-file": "tools/cli/.java-version" } },
    ]);
    expect(renderReleaseWorkflow({ forge: "github", groups: new Set(), pipeline: { toolchains: ["rust"] } })).toContain(`actions-rust-lang/setup-rust-toolchain@${ACTION_PINS.setupRustToolchain2.sha} # ${ACTION_PINS.setupRustToolchain2.tag}`);
  });

  test("toolchains: false sets nothing up, and install: false installs nothing", () => {
    const doc = parseYAML(dispatch("github", { pipeline: { trigger: "dispatch", toolchains: false, install: false } })) as GhDoc;
    for (const job of Object.values(doc.jobs)) expect(steps(job).map((s) => s.uses)).toEqual(["actions/checkout"]);
    expect(Object.values(doc.jobs).flatMap(runs)).not.toContain("npm ci");
  });

  test("a package.json project renders as before when the files are given", () => {
    for (const forge of FORGES) expect(dispatch(forge, { projectFiles: ["package.json"] })).toBe(dispatch(forge));
    expect(renderReleaseWorkflow({ forge: "github", groups: new Set(), projectFiles: ["package.json"] })).toBe(renderReleaseWorkflow({ forge: "github", groups: new Set() }));
  });

  const builds = [
    { name: "linux-arm64", runner: "ubuntu-24.04-arm", build: 'go build -ldflags "-X main.version=$CHANT_RELEASE_LABEL" -o dist/acme-linux-arm64 .', outputs: ["dist/acme-linux-arm64"] },
    { name: "darwin", runner: "macos-15", build: "make dist", outputs: ["dist/acme-darwin-*"], env: { CGO_ENABLED: "0" } },
    { name: "windows", runner: ["windows-latest"], build: "go build -o dist/acme.exe .", outputs: ["dist/acme.exe"], install: false as const },
  ];

  test("GitHub: a build job per runner, reading only, with no secrets, whose archive the cut unpacks before it cuts and the publish before it publishes", () => {
    const doc = parseYAML(dispatch("github", { projectFiles: ["go.mod"], pipeline: { trigger: "dispatch", builds, env: { OCI_PASSWORD: "${{ secrets.OCI }}" } } })) as GhDoc & { jobs: Record<string, GhJob & { "runs-on": unknown; permissions?: unknown; defaults?: unknown }> };
    const arm = doc.jobs["build-linux-arm64"]!;
    expect(arm.needs).toBe("gate");
    expect(arm["runs-on"]).toBe("ubuntu-24.04-arm");
    expect(arm.permissions).toEqual({ contents: "read" });
    expect(arm.defaults).toEqual({ run: { shell: "bash" } });
    expect(arm.env).toBeUndefined();
    expect(steps(arm)).toEqual([
      { uses: "actions/checkout", with: { ref: "${{ needs.gate.outputs.commit }}", "fetch-depth": 0, "persist-credentials": false } },
      { uses: "actions/setup-go", with: { "go-version-file": "go.mod", cache: false } },
      { uses: "actions/upload-artifact", with: { name: "chant-release-build-linux-arm64", path: "chant-release-build-linux-arm64.tar", "if-no-files-found": "error", "retention-days": 1 } },
    ]);
    expect(runs(arm)).toEqual(["npm ci", builds[0]!.build, "tar -cf chant-release-build-linux-arm64.tar -- dist/acme-linux-arm64"]);
    expect(doc.jobs["build-darwin"]!.env).toEqual({ CGO_ENABLED: "0" });
    expect(doc.jobs["build-windows"]!["runs-on"]).toEqual(["windows-latest"]);
    expect(runs(doc.jobs["build-windows"]!)[0]).toBe(builds[2]!.build);
    expect(doc.jobs.cut!.needs).toEqual(["gate", "build-linux-arm64", "build-darwin", "build-windows"]);
    expect(doc.jobs.publish!.needs).toEqual(["gate", "cut", "build-linux-arm64", "build-darwin", "build-windows"]);
    const cut = runs(doc.jobs.cut!);
    const unpack = cut.indexOf('tar -xkf "$RUNNER_TEMP/chant-release-builds/chant-release-build-darwin.tar"');
    expect(unpack).toBeGreaterThan(-1);
    expect(unpack).toBeLessThan(cut.findIndex((l) => l.includes("release cut")));
    const pub = runs(doc.jobs.publish!);
    expect(pub.indexOf('tar -xf "$RUNNER_TEMP/chant-release-builds/chant-release-build-windows.tar"')).toBeLessThan(pub.findIndex((l) => l.includes("release publish")));
    expect(doc.jobs.cut!.steps.filter((s) => s.uses?.startsWith("actions/download-artifact@")).map((s) => s.with)).toEqual(
      builds.map((b) => ({ name: `chant-release-build-${b.name}`, path: "${{ runner.temp }}/chant-release-builds" })),
    );
  });

  test("Forgejo uses the v3 artifact actions; a member root places the archive under it", () => {
    const text = dispatch("forgejo", { workspaceRoot: "cli", projectFiles: ["go.mod"], pipeline: { trigger: "dispatch", builds: builds.slice(0, 1) } });
    const doc = parseYAML(text) as GhDoc;
    const up = doc.jobs["build-linux-arm64"]!.steps.find((s) => s.uses?.startsWith("actions/upload-artifact@"))!;
    expect(up.uses).toBe(`actions/upload-artifact@${ACTION_PINS.uploadArtifact3.sha}`);
    expect(up.with!.path).toBe("cli/chant-release-build-linux-arm64.tar");
    expect(doc.jobs.cut!.steps.find((s) => s.uses?.startsWith("actions/download-artifact@"))!.uses).toBe(`actions/download-artifact@${ACTION_PINS.downloadArtifact3.sha}`);
    expect(text).toContain('go-version-file: "cli/go.mod"');
  });

  test("GitLab: build jobs on their runners' tags, whose archives the cut and publish need, unpack and move out of the checkout", () => {
    const doc = parseYAML(dispatch("gitlab", { pipeline: { trigger: "dispatch", builds: builds.slice(0, 2) } })) as Record<string, { needs?: string[]; tags?: string[]; script: string[]; variables?: Record<string, string>; artifacts?: { paths: string[] } }>;
    const arm = doc["chant-release-build-linux-arm64"]!;
    expect(arm.tags).toEqual(["ubuntu-24.04-arm"]);
    expect(arm.needs).toEqual(["chant-release-gate"]);
    expect(arm.artifacts!.paths).toEqual(["chant-release-build-linux-arm64.tar"]);
    expect(arm.script).toEqual(['git checkout --detach "$CHANT_RELEASE_COMMIT"', "npm ci", builds[0]!.build, "tar -cf chant-release-build-linux-arm64.tar -- dist/acme-linux-arm64"]);
    expect(doc["chant-release-build-darwin"]!.variables).toEqual({ GIT_DEPTH: "0", CGO_ENABLED: "0" });
    expect(doc["chant-release-cut"]!.needs).toEqual(["chant-release-gate", "chant-release-build-linux-arm64", "chant-release-build-darwin"]);
    const cut = doc["chant-release-cut"]!.script;
    expect(cut.indexOf("tar -xkf chant-release-build-darwin.tar")).toBeLessThan(cut.findIndex((l) => l.includes("release cut")));
    expect(cut).toContain("mv chant-release-build-darwin.tar /tmp/");
    expect(doc["chant-release-publish"]!.script).toContain("tar -xf chant-release-build-linux-arm64.tar");
  });

  test("refusals: builds with the tag trigger, an output outside the project, a name twice, and a GitLab toolchain", () => {
    const b = builds[0]!;
    expect(() => renderReleaseWorkflow({ forge: "github", groups: new Set(), pipeline: { builds: [b] } })).toThrow(/release\.workflow\.builds: the tag trigger/);
    expect(() => dispatch("github", { pipeline: { trigger: "dispatch", builds: [{ ...b, outputs: ["../secrets"] }] } })).toThrow(/not a path inside the project/);
    expect(() => dispatch("github", { pipeline: { trigger: "dispatch", builds: [{ ...b, outputs: ["dist/a; curl x"] }] } })).toThrow(/not a path inside the project/);
    expect(() => dispatch("github", { pipeline: { trigger: "dispatch", builds: [b, b] } })).toThrow(/linux-arm64 is named twice/);
    expect(() => dispatch("gitlab", { pipeline: { trigger: "dispatch", toolchains: ["go"] } })).toThrow(/runner's image/);
    expect(() => dispatch("github", { pipeline: { trigger: "dispatch", toolchains: ["go", "go"] } })).toThrow(/go is named twice/);
  });
});

describe("release.tag templates in the workflow (#5150)", () => {
  const tagsOf = (tag: Parameters<typeof resolveTagTemplate>[0], member: string | null = null, path: string | null = null): MemberTags => ({ place: { member, path }, template: resolveTagTemplate(tag, member) });

  test("an unset release.tag renders the release/** file it always did", () => {
    for (const forge of FORGES) {
      for (const root of [".", "packages/app"]) {
        const file = `${forge}-plain${root === "." ? "" : "-member"}.yml`;
        expect(renderReleaseWorkflow({ forge, groups: new Set(), workspaceRoot: root, tags: tagsOf(undefined, root === "." ? null : "app") }), file).toBe(readFileSync(join(FIXTURES, file), "utf-8"));
      }
    }
  });

  test("GitHub and Forgejo run on the template's tags, skip the floating tag, and read the label from the ledger", () => {
    for (const forge of ["github", "forgejo"] as const) {
      const text = renderReleaseWorkflow({ forge, groups: SECURE, tags: tagsOf({ name: "v{version}", floating: "v{major}" }), version: true, pipeline: { after: ["echo $CHANT_RELEASE_LABEL"] } });
      const doc = parseYAML(text) as { on: { push: { tags: string[] } }; jobs: Record<string, { steps: Array<{ run?: string; id?: string }>; outputs?: Record<string, string>; env?: Record<string, string> }> };
      expect(doc.on.push.tags).toEqual(["v*", "!v[0-9]+"]);
      const runs = doc.jobs.publish!.steps.map((s) => s.run ?? "");
      const ledger = runs.indexOf("git fetch origin chant/lifecycle:chant/lifecycle");
      const label = doc.jobs.publish!.steps.findIndex((s) => s.id === "label");
      const stamp = runs.findIndex((r) => r.startsWith("npx chant release stamp"));
      expect(ledger).toBeGreaterThan(-1);
      expect(label).toBe(ledger + 1);
      expect(stamp).toBe(label + 1);
      expect(runs[label]).toContain('npx chant release tag "$GITHUB_REF_NAME" --json');
      expect(runs.at(-1)).toBe('npx chant release publish "$CHANT_RELEASE_LABEL" --require-provenance --yes');
      expect(runs).toContain('npx chant release verify "$CHANT_RELEASE_LABEL"');
      expect(text).not.toContain("release/");
      expect(doc.jobs.publish!.outputs).toEqual({ label: "${{ steps.label.outputs.label }}" });
      expect(doc.jobs["after-release"]!.env).toEqual({ CHANT_RELEASE_LABEL: "${{ needs.publish.outputs.label }}" });
    }
  });

  test("a member's {member} and {path} are filled in the trigger, and glob characters are escaped", () => {
    const doc = (t: MemberTags) => (parseYAML(renderReleaseWorkflow({ forge: "github", groups: new Set(), workspaceRoot: "go/sub", tags: t })) as { on: { push: { tags: string[] } } }).on.push.tags;
    expect(doc(tagsOf("{path}/v{version}", "sub", "go/sub"))).toEqual(["go/sub/v*"]);
    expect(doc(tagsOf("{member}-v{version}", "cli", "go/sub"))).toEqual(["cli-v*"]);
    expect(doc(tagsOf("c++-{label}", "cli", "go/sub"))).toEqual(["c\\+\\+-*"]);
  });

  test("GitLab's rule matches the template's tags and not the floating tag", () => {
    const text = renderReleaseWorkflow({ forge: "gitlab", groups: new Set(), tags: tagsOf({ name: "cli/v{version}", floating: "cli/v{major}" }), pipeline: { after: ["echo done"] } });
    const doc = parseYAML(text) as Record<string, { rules: Array<{ if: string }>; script: string[] }>;
    expect(doc["chant-release-publish"]!.rules[0]!.if).toBe("$CI_COMMIT_TAG =~ /^cli\\/v[A-Za-z0-9._+-]+$/ && $CI_COMMIT_TAG !~ /^cli\\/v[0-9]+$/");
    const script = doc["chant-release-publish"]!.script;
    expect(script).toContain('export CHANT_RELEASE_LABEL="$label"');
    expect(script.at(-1)).toBe('npx chant release publish "$CHANT_RELEASE_LABEL" --yes');
    expect(doc["chant-release-after"]!.script).toContain('export CHANT_RELEASE_LABEL="$label"');
  });

  test("a template's tag workflow sets up the toolchains the project's files name, as the release/** one does (#5152)", () => {
    const text = renderReleaseWorkflow({ forge: "github", groups: new Set(), tags: tagsOf("v{version}"), projectFiles: ["go.mod"], install: null, pipeline: { after: ["echo done"] } });
    const setupGo = `actions/setup-go@${ACTION_PINS.setupGo7.sha} # ${ACTION_PINS.setupGo7.tag}`;
    expect(text.split(setupGo).length - 1).toBe(2);
    expect(text).not.toContain("npm ci");
    const legacy = renderReleaseWorkflow({ forge: "github", groups: new Set(), projectFiles: ["go.mod"], install: null, pipeline: { after: ["echo done"] } });
    expect(legacy.split(setupGo).length - 1).toBe(2);
  });

  test("a dispatched release pushes the tag the cut made, whatever the template", () => {
    const text = renderReleaseWorkflow({ forge: "github", groups: new Set(), tags: tagsOf("v{version}"), pipeline: { trigger: "dispatch" } });
    expect(text).toContain('git push origin "refs/tags/$tag"');
    expect(text).not.toContain("tags: [");
  });
});

describe("release doctor in the workflow (#5161)", () => {
  test("a dispatched release runs it in the cut job before the cut, on every forge, and doctor: false leaves it out", () => {
    for (const forge of ["github", "forgejo"] as const) {
      const cut = runs((parseYAML(dispatch(forge)) as GhDoc).jobs.cut!);
      const at = cut.indexOf("npx chant release doctor");
      expect(at, forge).toBeGreaterThan(0);
      expect(at).toBeLessThan(cut.findIndex((r) => r.includes("release cut")));
      expect(cut.indexOf("npm ci")).toBeLessThan(at);
      const off = runs((parseYAML(dispatch(forge, { pipeline: { trigger: "dispatch", doctor: false } })) as GhDoc).jobs.cut!);
      expect(off).not.toContain("npx chant release doctor");
      // The publish job does not run it again.
      expect(runs((parseYAML(dispatch(forge)) as GhDoc).jobs.publish!)).not.toContain("npx chant release doctor");
    }
    const gl = parseYAML(dispatch("gitlab")) as Record<string, { script: string[] }>;
    const script = gl["chant-release-cut"]!.script;
    expect(script.indexOf("npx chant release doctor")).toBeGreaterThan(0);
    expect(script.indexOf("npx chant release doctor")).toBeLessThan(script.findIndex((l) => l.includes("release cut")));
    expect((parseYAML(dispatch("gitlab", { pipeline: { trigger: "dispatch", doctor: false } })) as Record<string, { script: string[] }>)["chant-release-cut"]!.script).not.toContain("npx chant release doctor");
  });

  test("the tag trigger runs it in the publish job before the build only under doctor: true", () => {
    const on = runs((parseYAML(renderReleaseWorkflow({ forge: "github", groups: new Set(), pipeline: { doctor: true } })) as GhDoc).jobs.publish!);
    expect(on.slice(0, 3)).toEqual(["npm ci", "npx chant release doctor", "npm run build"]);
    const gl = parseYAML(renderReleaseWorkflow({ forge: "gitlab", groups: new Set(), pipeline: { doctor: true } })) as Record<string, { script: string[] }>;
    expect(gl["chant-release-publish"]!.script.slice(0, 3)).toEqual(["npm ci", "npx chant release doctor", "npm run build"]);
    expect(renderReleaseWorkflow({ forge: "github", groups: new Set(), pipeline: { doctor: false } })).toBe(readFileSync(join(FIXTURES, "github-plain.yml"), "utf-8"));
  });

  const ghForge = [{ type: "forge" as const, forge: "github" as const, repo: "acme/app", assets: ["dist/acme"] }];

  test("under forge-checks with a GitHub forge target, the cut job gets GITHUB_TOKEN once, and the doctor runs with it", () => {
    const doc = parseYAML(dispatch("github", { green: "forge-checks", publish: ghForge })) as GhDoc;
    expect(doc.jobs.cut!.env).toEqual({ CHANT_RELEASE_COMMIT: "${{ needs.gate.outputs.commit }}", GITHUB_TOKEN: "${{ github.token }}" });
    expect(doc.permissions).toMatchObject({ checks: "read", statuses: "read" });
    expect(runs(doc.jobs.cut!)).toContain("npx chant release doctor");
    // doctor: false keeps forge-checks' token and drops nothing else.
    const off = parseYAML(dispatch("github", { green: "forge-checks", publish: ghForge, pipeline: { trigger: "dispatch", doctor: false } })) as GhDoc;
    expect(off.jobs.cut!.env).toEqual({ CHANT_RELEASE_COMMIT: "${{ needs.gate.outputs.commit }}", GITHUB_TOKEN: "${{ github.token }}" });
    const chant = parseYAML(dispatch("github", { publish: ghForge })) as GhDoc;
    expect(chant.jobs.cut!.env).toEqual({ CHANT_RELEASE_COMMIT: "${{ needs.gate.outputs.commit }}", GITHUB_TOKEN: "${{ github.token }}" });
  });

  test("GitLab forge-checks: the doctor runs after the cut's token for the pipelines is set, and before the cut", () => {
    const script = (parseYAML(dispatch("gitlab", { green: "forge-checks" })) as Record<string, { script: string[] }>)["chant-release-cut"]!.script;
    const at = script.indexOf("npx chant release doctor");
    expect(at).toBeGreaterThan(script.indexOf('export CHANT_GITLAB_TOKEN="${CHANT_GITLAB_TOKEN:-$CHANT_RELEASE_TOKEN}"'));
    expect(at).toBeLessThan(script.findIndex((l) => l.includes("release cut")));
  });

  test("with per-platform builds, the doctor runs once, in the cut job after its toolchains and install and before the cut; the build jobs never run it", () => {
    const builds = [{ name: "linux-arm64", runner: "ubuntu-24.04-arm", build: "go build -o dist/acme .", outputs: ["dist/acme"] }];
    const doc = parseYAML(dispatch("github", { projectFiles: ["go.mod", "package.json"], pipeline: { trigger: "dispatch", builds } })) as GhDoc;
    expect(runs(doc.jobs["build-linux-arm64"]!)).not.toContain("npx chant release doctor");
    const cut = doc.jobs.cut!;
    const stepAt = (pred: (s: GhJob["steps"][number]) => boolean) => cut.steps.findIndex(pred);
    const doctor = stepAt((s) => s.run?.trim() === "npx chant release doctor");
    expect(doctor).toBeGreaterThan(stepAt((s) => !!s.uses?.startsWith("actions/setup-go@")));
    expect(doctor).toBeGreaterThan(stepAt((s) => s.run?.trim() === "npm ci"));
    expect(doctor).toBeLessThan(stepAt((s) => !!s.run?.includes("release cut")));
    expect(Object.values(doc.jobs).flatMap(runs).filter((r) => r === "npx chant release doctor")).toHaveLength(1);
  });

  test("a release.tag template's workflow runs it under doctor: true after the label is read and before the stamp", () => {
    const tags: MemberTags = { place: { member: null, path: null }, template: resolveTagTemplate("v{version}", null) };
    const doc = parseYAML(renderReleaseWorkflow({ forge: "github", groups: new Set(), tags, version: true, pipeline: { doctor: true } })) as GhDoc;
    const steps = doc.jobs.publish!.steps;
    const label = steps.findIndex((s) => s.id === "label");
    expect(steps[label + 1]!.run?.trim()).toBe("npx chant release doctor");
    expect(steps[label + 2]!.run?.trim()).toMatch(/^npx chant release stamp/);
    const gl = (parseYAML(renderReleaseWorkflow({ forge: "gitlab", groups: new Set(), tags, version: true, pipeline: { doctor: true } })) as Record<string, { script: string[] }>)["chant-release-publish"]!.script;
    expect(gl.indexOf("npx chant release doctor")).toBe(gl.indexOf('export CHANT_RELEASE_LABEL="$label"') + 1);
    expect(renderReleaseWorkflow({ forge: "github", groups: new Set(), tags })).not.toContain("release doctor");
  });
});

describe("the cut hands the files release.artifacts built to the publish job (#5151)", () => {
  type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown> };
  const jobs = (forge: "github" | "forgejo", extra: Partial<ReleaseWorkflowInput> = {}, trigger: "dispatch" | "tag" = "dispatch") =>
    (parseYAML(renderReleaseWorkflow({ forge, groups: new Set(), artifacts: true, pipeline: { ...(trigger === "dispatch" ? { trigger } : {}), build: "npm run build" }, ...extra })) as { jobs: Record<string, { steps: Step[] }> }).jobs;

  test("GitHub: the cut stages the files and uploads them; the publish job downloads them and checks them before the publish", () => {
    const { cut, publish } = jobs("github");
    const stage = cut!.steps.findIndex((s) => s.run?.includes("release artifacts"));
    expect(cut!.steps[stage]!.run).toBe('npx chant release artifacts "$CHANT_RELEASE_LABEL" --no-build -o "$RUNNER_TEMP/chant-release-artifacts"');
    expect(cut!.steps[stage + 1]!.uses).toContain(ACTION_PINS.uploadArtifact4.sha);
    expect(cut!.steps[stage + 1]!.with).toMatchObject({ name: "chant-release-artifacts", path: "${{ runner.temp }}/chant-release-artifacts", "if-no-files-found": "error" });
    const down = publish!.steps.findIndex((s) => s.uses?.includes("download-artifact") && s.with?.name === "chant-release-artifacts");
    const check = publish!.steps.findIndex((s) => s.run?.includes("release artifacts"));
    const publishStep = publish!.steps.findIndex((s) => s.run?.includes("release publish"));
    expect(publish!.steps[down]!.with!.path).toBe("${{ runner.temp }}/chant-release-artifacts");
    expect(publish!.steps[check]!.run).toBe('npx chant release artifacts "$CHANT_RELEASE_LABEL" --from "$RUNNER_TEMP/chant-release-artifacts"');
    expect(down).toBeLessThan(check);
    expect(check).toBeGreaterThan(publish!.steps.findIndex((s) => s.run === "npm run build"));
    expect(check).toBeLessThan(publishStep);
  });

  test("Forgejo takes v3 of the artifact actions", () => {
    const { cut, publish } = jobs("forgejo");
    expect(cut!.steps.some((s) => s.uses?.includes(ACTION_PINS.uploadArtifact3.sha))).toBe(true);
    expect(publish!.steps.some((s) => s.uses?.includes(ACTION_PINS.downloadArtifact3.sha))).toBe(true);
  });

  test("on a release tag the publish job builds the files again and checks them, after the ledger is fetched", () => {
    const { publish } = jobs("github", {}, "tag");
    const fetch = publish!.steps.findIndex((s) => s.run?.includes("chant/lifecycle:chant/lifecycle"));
    const build = publish!.steps.findIndex((s) => s.run?.includes("release artifacts"));
    expect(publish!.steps[build]!.run).toBe('npx chant release artifacts "${GITHUB_REF_NAME#release/}"');
    expect(fetch).toBeLessThan(build);
  });

  test("GitLab: the cut keeps the staged files, and the publish job moves them out of the checkout before it checks them", () => {
    const doc = parseYAML(renderReleaseWorkflow({ forge: "gitlab", groups: new Set(), artifacts: true, pipeline: { trigger: "dispatch" } })) as Record<string, { artifacts?: { paths: string[] }; script: string[] }>;
    expect(doc["chant-release-cut"]!.script).toContain('npx chant release artifacts "$CHANT_RELEASE_LABEL" --no-build -o "$CI_PROJECT_DIR/.chant-release-artifacts"');
    expect(doc["chant-release-cut"]!.artifacts!.paths).toEqual([".chant-release-artifacts/"]);
    const script = doc["chant-release-publish"]!.script;
    expect(script.indexOf('mv "$CI_PROJECT_DIR/.chant-release-artifacts" /tmp/chant-release-artifacts')).toBeLessThan(script.indexOf('npx chant release artifacts "$CHANT_RELEASE_LABEL" --from /tmp/chant-release-artifacts'));
  });

  test("a goreleaser entry installs Go and the pinned goreleaser, checked by SHA-256, in the job that builds", () => {
    const { cut, publish } = jobs("github", { goreleaser: true, workspaceRoot: "cli" });
    const go = cut!.steps.find((s) => s.uses?.startsWith("actions/setup-go@"));
    expect(go!.uses).toContain(ACTION_PINS.setupGo7.sha);
    expect(go!.with).toEqual({ "go-version-file": "cli/go.mod" });
    const install = cut!.steps.find((s) => s.name?.startsWith("goreleaser "))!;
    expect(install.run).toContain(TOOL_PINS.goreleaser.platforms["linux/amd64"]!.sha256);
    expect(install.run).toContain("sha256sum -c -");
    expect(install.run).toContain('CHANT_GORELEASER=$RUNNER_TEMP/goreleaser/goreleaser');
    expect(cut!.steps.indexOf(install)).toBeLessThan(cut!.steps.findIndex((s) => s.run?.includes("release cut")));
    // The publish job of a dispatched release builds nothing, so it installs nothing.
    expect(publish!.steps.some((s) => s.name?.startsWith("goreleaser "))).toBe(false);
    expect(jobs("github", { goreleaser: true }, "tag").publish!.steps.some((s) => s.name?.startsWith("goreleaser "))).toBe(true);
    // A config that names its own setup-go and goreleaser gets neither.
    const own = jobs("github", { goreleaser: true, pipeline: { trigger: "dispatch", setup: [{ uses: "actions/setup-go@abc" }], env: { CHANT_GORELEASER: "/usr/bin/goreleaser" } } });
    expect(own.cut!.steps.filter((s) => s.uses?.startsWith("actions/setup-go@")).map((s) => s.uses)).toEqual(["actions/setup-go@abc"]);
    expect(own.cut!.steps.some((s) => s.name?.startsWith("goreleaser "))).toBe(false);
    const gitlab = parseYAML(renderReleaseWorkflow({ forge: "gitlab", groups: new Set(), artifacts: true, goreleaser: true, pipeline: { trigger: "dispatch" } })) as Record<string, { script: string[] }>;
    expect(gitlab["chant-release-cut"]!.script.some((l) => l.includes(TOOL_PINS.goreleaser.platforms["linux/amd64"]!.url) && l.endsWith("export CHANT_GORELEASER=/tmp/goreleaser/goreleaser"))).toBe(true);
  });

  test("without release.artifacts the files render as before", () => {
    const plain = renderReleaseWorkflow({ forge: "github", groups: new Set(), pipeline: { trigger: "dispatch" } });
    expect(plain).not.toContain("chant-release-artifacts");
    expect(plain).not.toContain("goreleaser");
  });
});

describe("release.artifacts under a release.tag template (#5151)", () => {
  test("the publish job builds the artifacts after the ledger fetch and before the build", () => {
    const tags: MemberTags = { place: { member: null, path: null }, template: resolveTagTemplate("v{version}", null) };
    const doc = parseYAML(renderReleaseWorkflow({ forge: "github", groups: new Set(), tags, artifacts: true, pipeline: { build: "npm run build" } })) as GhDoc;
    const runs = doc.jobs.publish!.steps.map((s) => s.run?.trim() ?? "");
    const a = runs.findIndex((r) => r.startsWith("npx chant release artifacts"));
    expect(a).toBeGreaterThan(runs.findIndex((r) => r.startsWith("git fetch origin chant/lifecycle")));
    expect(a).toBeLessThan(runs.indexOf("npm run build"));
    const gl = (parseYAML(renderReleaseWorkflow({ forge: "gitlab", groups: new Set(), tags, artifacts: true, pipeline: { build: "npm run build" } })) as Record<string, { script: string[] }>)["chant-release-publish"]!.script;
    expect(gl.findIndex((l) => l.startsWith("npx chant release artifacts"))).toBeLessThan(gl.indexOf("npm run build"));
  });
});
