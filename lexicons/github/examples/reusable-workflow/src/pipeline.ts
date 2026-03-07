import {
  Workflow, Job, Step,
  Checkout, SetupNode,
  inputs,
} from "@intentius/chant-lexicon-github";

// ── Reusable (called) workflow ─────────────────────────────────────
// This workflow is called by other workflows via workflow_call.

export const reusableWorkflow = new Workflow({
  name: "Reusable CI",
  on: {
    workflow_call: {
      inputs: {
        "node-version": {
          description: "Node.js version to use",
          required: false,
          type: "string",
          default: "22",
        },
        "run-lint": {
          description: "Whether to run linting",
          required: false,
          type: "boolean",
          default: true,
        },
      },
      secrets: {
        NPM_TOKEN: {
          description: "npm authentication token",
          required: false,
        },
      },
    },
  },
  permissions: { contents: "read" },
});

export const ci = new Job({
  "runs-on": "ubuntu-latest",
  timeoutMinutes: 15,
  steps: [
    Checkout({}).step,
    SetupNode({
      nodeVersion: inputs("node-version").toString(),
      cache: "npm",
    }).step,
    new Step({ name: "Install", run: "npm ci" }),
    new Step({
      name: "Lint",
      if: inputs("run-lint").toString(),
      run: "npm run lint",
    }),
    new Step({ name: "Test", run: "npm test" }),
    new Step({ name: "Build", run: "npm run build" }),
  ],
});

// ── Caller workflow ────────────────────────────────────────────────
// This workflow calls the reusable workflow above.

export const callerWorkflow = new Workflow({
  name: "CI Pipeline",
  on: {
    push: { branches: ["main"] },
    pull_request: { branches: ["main"] },
  },
});

export const callCi = new Job({
  "runs-on": "ubuntu-latest",
  uses: "./.github/workflows/reusable-workflow.yml",
  with: {
    "node-version": "22",
    "run-lint": "true",
  },
  secrets: "inherit",
});
