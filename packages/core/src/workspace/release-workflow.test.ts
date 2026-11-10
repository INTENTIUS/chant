/** #4656: `chant release workflow` renders the release pipeline from the `release` block. */
import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseYAML } from "../yaml";
import { ACTION_PINS } from "../action-pins";
import { NPM_TRUSTED_PUBLISHING_SETUP, renderReleaseWorkflow, RELEASE_DIGESTS_PATHS, type ReleaseWorkflowInput, type ReleaseWorkflowTarget } from "./release-workflow";
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
        expect(doc.jobs.cut!.env).toEqual({ CHANT_RELEASE_COMMIT: "${{ needs.gate.outputs.commit }}" });
        expect(doc.jobs.gate!.env).toBeUndefined();
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

  test("on GitLab, a binfmt run line in the cut and the publish", () => {
    const doc = parseYAML(render("gitlab", TWO)) as Record<string, { script: string[] }>;
    for (const job of ["chant-release-cut", "chant-release-publish"]) {
      const script = doc[job]!.script;
      expect(script[script.indexOf("npm ci") + 1], job).toBe("docker run --privileged --rm tonistiigi/binfmt --install arm64");
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
