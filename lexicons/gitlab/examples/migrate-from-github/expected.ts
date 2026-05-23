// Migrated from input/ci.yml by chant migrate.
// Source tool: github-actions. Edit freely — chant build will pick this up.

import { Artifacts, Cache, Job, Parallel, Rule, Workflow } from "@intentius/chant-lexicon-gitlab";

// Pipeline stages: build, test, deploy

export const workflow = new Workflow({
    name: "Node CI",
    rules: [
      new Rule({
        if: "$CI_PIPELINE_SOURCE == \"push\"",
      }),
      new Rule({
        if: "$CI_PIPELINE_SOURCE == \"merge_request_event\"",
      }),
    ],
  });

export const build = new Job({
    image: "node:22",
    cache: new Cache({
      key: {
        files: ["package-lock.json"],
      },
      paths: [".npm/"],
    }),
    artifacts: new Artifacts({
      paths: ["dist/"],
      name: "dist",
      expire_in: "7 days",
    }),
    script: ["npm ci", "npm run build"],
    stage: "build",
  });

export const test = new Job({
    image: "node:${{ matrix.node }}",
    timeout: "15 minutes",
    parallel: new Parallel({
      matrix: [{
          NODE: [18, 20, 22],
        }],
    }),
    needs: ["build"],
    script: ["npm ci", "npm test"],
    stage: "test",
  });

export const deploy = new Job({
    image: "ubuntu:24.04",
    rules: [
      new Rule({
        if: "$CI_COMMIT_REF_NAME == 'refs/heads/main' && $CI_PIPELINE_SOURCE == 'push'",
      }),
    ],
    needs: ["test"],
    script: ["./deploy.sh"],
    stage: "deploy",
  });
