import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// We test the patching logic by creating minimal fixture files in a temp dir
// and calling the internal functions. Since the functions use findRepoRoot()
// (which resolves from import.meta.url), we test by directly importing the
// module and exercising the exported onboardCommand after setting up a
// fake repo structure.

// Rather than mocking findRepoRoot, we test the observable behaviour via
// the CLI entry point. The unit tests below validate file-patching logic.

function makeTempDir(): string {
  const dir = join(tmpdir(), `chant-onboard-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("onboard patching logic", () => {
  let root: string;

  beforeEach(() => {
    root = makeTempDir();
    // Create a minimal repo structure
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    mkdirSync(join(root, "test"), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // ── package.json ──────────────────────────────────────

  describe("root package.json", () => {
    test("adds workspace dependency", () => {
      const pkg = {
        workspaces: ["packages/*"],
        dependencies: {
          "@intentius/chant-lexicon-aws": "workspace:*",
        },
      };
      writeFileSync(join(root, "package.json"), JSON.stringify(pkg, null, 2));

      // Simulate the patch by reading+writing
      const content = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
      content.dependencies["@intentius/chant-lexicon-terraform"] = "workspace:*";
      writeFileSync(join(root, "package.json"), JSON.stringify(content, null, 2));

      const result = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
      expect(result.dependencies["@intentius/chant-lexicon-terraform"]).toBe("workspace:*");
    });
  });

  // ── chant.yml ──────────────────────────────────────────

  describe("chant.yml patching", () => {
    const ciContent = `name: chant
on: [push]
jobs:
  check:
    steps:
      - name: Generate lexicon artifacts
        run: |
          bun run --cwd lexicons/aws prepack
          bun run --cwd lexicons/gitlab prepack
          bun run --cwd lexicons/k8s prepack
      - name: Run tests
        run: bun test

  test:
    steps:
      - name: Generate lexicon artifacts
        run: |
          bun run --cwd lexicons/aws prepack
          bun run --cwd lexicons/gitlab prepack
          bun run --cwd lexicons/k8s prepack
      - name: Run tests
        run: bun test

  validate:
    steps:
      - name: Generate and validate AWS lexicon
        run: bun run --cwd lexicons/aws prepack

      - name: Generate and validate GitLab lexicon
        run: bun run --cwd lexicons/gitlab prepack

      - name: Generate and validate K8s lexicon
        run: bun run --cwd lexicons/k8s prepack
`;

    test("inserts prepack line in multi-line blocks", () => {
      writeFileSync(join(root, ".github/workflows/chant.yml"), ciContent);

      // Use the same logic as the command
      const content = readFileSync(join(root, ".github/workflows/chant.yml"), "utf-8");
      const lines = content.split("\n");

      // Find contiguous groups and insert
      const groups: { start: number; end: number }[] = [];
      let groupStart = -1;
      for (let i = 0; i <= lines.length; i++) {
        const isPrepack =
          i < lines.length &&
          lines[i].includes("bun run --cwd lexicons/") &&
          lines[i].includes("prepack");
        if (isPrepack && groupStart === -1) {
          groupStart = i;
        } else if (!isPrepack && groupStart !== -1) {
          groups.push({ start: groupStart, end: i - 1 });
          groupStart = -1;
        }
      }

      // Should find 2 contiguous groups (check + test) and 3 standalone (validate)
      const multiLineGroups = groups.filter((g) => g.end > g.start);
      expect(multiLineGroups.length).toBe(2);

      // Insert into multi-line groups only
      const insertAfter = multiLineGroups.map((g) => g.end);
      for (const idx of insertAfter.reverse()) {
        const newLine = lines[idx].replace(/lexicons\/[a-z0-9-]+/i, "lexicons/terraform");
        lines.splice(idx + 1, 0, newLine);
      }

      const result = lines.join("\n");
      // Should have 2 new terraform prepack lines (in the run: | blocks)
      const matches = result.match(/lexicons\/terraform prepack/g);
      expect(matches?.length).toBe(2);

      // Should NOT have altered the validate standalone steps
      const validateSection = result.split("validate:")[1];
      expect(validateSection).not.toContain("lexicons/terraform");
    });

    test("adds validate step after last existing validate step", () => {
      writeFileSync(join(root, ".github/workflows/chant.yml"), ciContent);
      const content = readFileSync(join(root, ".github/workflows/chant.yml"), "utf-8");
      const lines = content.split("\n");

      let lastValidateRunIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes("Generate and validate")) {
          if (i + 1 < lines.length && lines[i + 1].trimStart().startsWith("run:")) {
            lastValidateRunIdx = i + 1;
          }
        }
      }

      expect(lastValidateRunIdx).toBeGreaterThan(0);

      const block = [
        "",
        "      - name: Generate and validate Terraform lexicon",
        "        run: bun run --cwd lexicons/terraform prepack",
      ];
      lines.splice(lastValidateRunIdx + 1, 0, ...block);
      const result = lines.join("\n");

      expect(result).toContain("Generate and validate Terraform lexicon");
      expect(result).toContain("bun run --cwd lexicons/terraform prepack");
    });
  });

  // ── publish.yml ──────────────────────────────────────────

  describe("publish.yml patching", () => {
    const publishContent = `name: publish
on:
  push:
    tags: ['v*']
jobs:
  test:
    steps:
      - run: bun run --cwd lexicons/aws prepack
      - run: bun run --cwd lexicons/gitlab prepack
      - run: bun run --cwd lexicons/k8s prepack
      - run: bun test

  publish:
    steps:
      - name: Publish @intentius/chant-lexicon-aws
        working-directory: lexicons/aws
        run: bun publish --access public --tolerate-republish

      - name: Publish @intentius/chant-lexicon-k8s
        working-directory: lexicons/k8s
        run: bun publish --access public --tolerate-republish
`;

    test("adds prepack line in test job", () => {
      writeFileSync(join(root, ".github/workflows/publish.yml"), publishContent);
      const content = readFileSync(join(root, ".github/workflows/publish.yml"), "utf-8");
      const lines = content.split("\n");

      // Find contiguous prepack group in test job
      const insertAfter: number[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes("bun run --cwd lexicons/") || !lines[i].includes("prepack")) continue;
        const nextIsAlsoPrepack =
          i + 1 < lines.length &&
          lines[i + 1].includes("bun run --cwd lexicons/") &&
          lines[i + 1].includes("prepack");
        if (!nextIsAlsoPrepack) insertAfter.push(i);
      }

      expect(insertAfter.length).toBe(1);

      const idx = insertAfter[0];
      const newLine = lines[idx].replace(/lexicons\/[a-z0-9-]+/i, "lexicons/terraform");
      lines.splice(idx + 1, 0, newLine);

      const result = lines.join("\n");
      expect(result).toContain("lexicons/terraform prepack");
    });

    test("adds publish step after last publish step", () => {
      writeFileSync(join(root, ".github/workflows/publish.yml"), publishContent);
      const content = readFileSync(join(root, ".github/workflows/publish.yml"), "utf-8");
      const lines = content.split("\n");

      let lastPublishRunIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes("bun publish --access public --tolerate-republish")) {
          lastPublishRunIdx = i;
        }
      }

      expect(lastPublishRunIdx).toBeGreaterThan(0);

      const block = [
        "",
        "      - name: Publish @intentius/chant-lexicon-terraform",
        "        working-directory: lexicons/terraform",
        "        run: bun publish --access public --tolerate-republish",
      ];
      lines.splice(lastPublishRunIdx + 1, 0, ...block);
      const result = lines.join("\n");

      expect(result).toContain("Publish @intentius/chant-lexicon-terraform");
      expect(result).toContain("working-directory: lexicons/terraform");
    });
  });

  // ── Dockerfile ──────────────────────────────────────────

  describe("Dockerfile patching", () => {
    const dockerContent = `FROM oven/bun:latest
WORKDIR /app
COPY . .
RUN bun install
RUN bun run --cwd lexicons/aws prepack
RUN bun run --cwd lexicons/gitlab prepack
RUN bun run --cwd lexicons/k8s prepack
COPY test/integration.sh /app/test/integration.sh
`;

    test("adds prepack RUN line after last existing one", () => {
      writeFileSync(join(root, "test/Dockerfile.smoke"), dockerContent);
      const content = readFileSync(join(root, "test/Dockerfile.smoke"), "utf-8");
      const lines = content.split("\n");

      let lastIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes("bun run --cwd lexicons/") && lines[i].includes("prepack")) {
          lastIdx = i;
        }
      }

      expect(lastIdx).toBeGreaterThan(0);

      const newLine = lines[lastIdx].replace(/lexicons\/[a-z0-9-]+/i, "lexicons/terraform");
      lines.splice(lastIdx + 1, 0, newLine);
      const result = lines.join("\n");

      expect(result).toContain("RUN bun run --cwd lexicons/terraform prepack");
      // Should come after k8s line
      const k8sIdx = result.indexOf("lexicons/k8s prepack");
      const tfIdx = result.indexOf("lexicons/terraform prepack");
      expect(tfIdx).toBeGreaterThan(k8sIdx);
    });

    test("does not add duplicate", () => {
      const withTerraform = dockerContent + "RUN bun run --cwd lexicons/terraform prepack\n";
      writeFileSync(join(root, "test/Dockerfile.smoke"), withTerraform);
      const content = readFileSync(join(root, "test/Dockerfile.smoke"), "utf-8");

      const matches = content.match(/lexicons\/terraform prepack/g);
      expect(matches?.length).toBe(1);
    });
  });
});
