import { expect } from "vitest";
import { describeAllExamples } from "@intentius/chant-test-utils/example-harness";
import { githubSerializer } from "@intentius/chant-lexicon-github";

describeAllExamples(
  {
    lexicon: "github",
    serializer: githubSerializer,
    outputKey: "github",
    examplesDir: import.meta.dirname,
  },
  {
    "getting-started": { skipLint: true },
    "node-ci": {
      skipLint: true,
      checks: (output) => {
        expect(output).toContain("Node.js CI");
        expect(output).toContain("node-version:");
        expect(output).toContain("npm ci");
        expect(output).toContain("npm run lint");
        expect(output).toContain("npm test");
        expect(output).toContain("npm run build");
      },
    },
    "docker-build": {
      skipLint: true,
      checks: (output) => {
        expect(output).toContain("name: Docker Build and Push");
        expect(output).toContain("docker/build-push-action@v6");
        expect(output).toContain("docker/login-action@v3");
        expect(output).toContain("linux/amd64,linux/arm64");
      },
    },
    "deploy-pages": {
      skipLint: true,
      checks: (output) => {
        expect(output).toContain("name: Deploy to GitHub Pages");
        expect(output).toContain("actions/upload-pages-artifact@v3");
        expect(output).toContain("actions/deploy-pages@v4");
        expect(output).toContain("github-pages");
      },
    },
    "release-please": {
      skipLint: true,
      checks: (output) => {
        expect(output).toContain("name: Release Please");
        expect(output).toContain("googleapis/release-please-action@v4");
        expect(output).toContain("npm publish");
      },
    },
    "matrix-test": {
      skipLint: true,
      checks: (output) => {
        expect(output).toContain("name: Dynamic Matrix Test");
        expect(output).toContain("set-matrix");
        expect(output).toContain("GITHUB_OUTPUT");
      },
    },
    "docs-snippets": { skipLint: true, skipBuild: true },
    "reusable-workflow": {
      skipLint: true,
      checks: (output) => {
        expect(output).toContain("uses: ./.github/workflows/reusable-workflow.yml");
        expect(output).toContain("node-version");
      },
    },
  },
);
