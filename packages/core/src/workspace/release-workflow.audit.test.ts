/**
 * #5268: the workflows `chant release workflow` writes pass `chant audit
 * --fail-on merge-worthy`, the claim the workflow page makes. Each shape is
 * rendered, written where a repository keeps it and audited with the GitHub
 * lexicon, the way a project that adopts the file runs the audit.
 */
import { beforeAll, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditCommand } from "../cli/commands/audit";
import { loadAuditPlugins } from "../audit/discover";
import type { LexiconPlugin } from "../lexicon";
import { renderReleaseWorkflow, type ReleaseWorkflowInput } from "./release-workflow";
import type { SecurityGroup } from "./security";

/** A Go project with goreleaser artifacts and a multi-platform image, as a goreleaser project that adopts `release init` has (mudflaps, spritzer). */
const goreleaserWithImages: ReleaseWorkflowInput = {
  forge: "github",
  groups: new Set(),
  install: null,
  build: null,
  projectFiles: ["go.mod"],
  images: true,
  imageArchives: ["out/images/app.tar"],
  imagePlatforms: ["linux/amd64", "linux/arm64"],
  artifacts: true,
  goreleaser: true,
  green: "forge-checks",
  publish: [
    { type: "forge", forge: "github" },
    { type: "oci", repository: "ghcr.io/acme/app" },
  ],
  pipeline: { trigger: "dispatch" },
};

const SHAPES: Array<[string, ReleaseWorkflowInput]> = [
  ["dispatch: goreleaser artifacts and images", goreleaserWithImages],
  ["dispatch: goreleaser artifacts, toolchains off", { ...goreleaserWithImages, pipeline: { trigger: "dispatch", toolchains: false } }],
  ["tag: goreleaser artifacts and images", { ...goreleaserWithImages, pipeline: {} }],
  [
    "dispatch: npm package with images and supply-chain",
    {
      forge: "github",
      groups: new Set<SecurityGroup>(["supply-chain", "verified-releases"]),
      images: true,
      imageArchives: ["dist/app.tar"],
      artifacts: true,
      publish: [{ type: "npm" }, { type: "forge", forge: "github" }],
      pipeline: { trigger: "dispatch" },
    },
  ],
  ["tag: npm package", { forge: "github", groups: new Set(), publish: [{ type: "npm" }] }],
  ["train dispatch: member goreleaser and images", { forge: "github", groups: new Set(), projectFiles: ["package.json", "go.mod"], pipeline: { trigger: "dispatch" }, train: { env: "npm", images: true, artifacts: true, goreleaser: true, goreleaserDir: "cli", imagePlatforms: ["linux/amd64", "linux/arm64"] } }],
];

let plugins: LexiconPlugin[];
beforeAll(async () => {
  plugins = await loadAuditPlugins(["github"]);
}, 120_000);

describe("the generated release workflow passes chant audit (#5268)", () => {
  for (const [name, input] of SHAPES) {
    test(name, async () => {
      const dir = mkdtempSync(join(tmpdir(), "chant-release-audit-"));
      mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
      writeFileSync(join(dir, ".github", "workflows", "release.yml"), renderReleaseWorkflow(input));
      const result = await auditCommand({ path: dir, failOn: "merge-worthy", tier: "merge-worthy", format: "json", plugins });
      const findings = result.findings.map((f) => `${f.checkId} ${f.entity ?? ""} ${f.message}`);
      expect(findings).toEqual([]);
      expect(result.exitCode).toBe(0);
    });
  }

  test("a cut that uploads checks out without persisting the token, and its git reads the job's", () => {
    const text = renderReleaseWorkflow(goreleaserWithImages);
    const cut = text.slice(text.indexOf("\n  cut:"), text.indexOf("\n  publish:"));
    expect(cut).toContain("persist-credentials: false");
    expect(cut).toContain("CHANT_RELEASE_GIT_TOKEN: ${{ github.token }}");
    expect(cut).toContain("GIT_CONFIG_KEY_0: credential.${{ github.server_url }}.helper");
    // Go is set up once, by the toolchain, without a cache.
    expect(cut.match(/actions\/setup-go@/g)).toHaveLength(1);
    expect(cut).toContain("cache: false");
    // A cut that hands nothing on keeps the checkout as it was.
    const plain = renderReleaseWorkflow({ forge: "github", groups: new Set(), pipeline: { trigger: "dispatch" } });
    expect(plain).not.toContain("persist-credentials: false");
    expect(plain).not.toContain("GIT_CONFIG_COUNT");
  });
});
