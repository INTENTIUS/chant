import {
  Workflow, Job, Step,
  Checkout, SetupNode,
  matrix, fromJSON, needs,
} from "@intentius/chant-lexicon-github";

export const workflow = new Workflow({
  name: "Dynamic Matrix Test",
  on: {
    push: { branches: ["main"] },
    pull_request: { branches: ["main"] },
  },
  permissions: { contents: "read" },
});

/**
 * First job: compute the test matrix dynamically.
 * Outputs a JSON array of configurations for downstream jobs.
 */
export const prepare = new Job({
  "runs-on": "ubuntu-latest",
  outputs: {
    matrix: "${{ steps.set-matrix.outputs.matrix }}",
  },
  steps: [
    Checkout({}).step,
    new Step({
      name: "Compute matrix",
      id: "set-matrix",
      run: [
        `MATRIX=$(cat <<'ENDJSON'`,
        `{"include":[`,
        `  {"os":"ubuntu-latest","node":"18","shard":"1/3"},`,
        `  {"os":"ubuntu-latest","node":"20","shard":"2/3"},`,
        `  {"os":"ubuntu-latest","node":"22","shard":"3/3"},`,
        `  {"os":"macos-latest","node":"22","shard":"1/3"}`,
        `]}`,
        `ENDJSON`,
        `)`,
        `echo "matrix=$MATRIX" >> "$GITHUB_OUTPUT"`,
      ].join("\n"),
    }),
  ],
});

/**
 * Second job: run tests using the dynamic matrix.
 * Each combination runs in parallel with fail-fast enabled.
 */
export const test = new Job({
  "runs-on": matrix("os").toString(),
  needs: ["prepare"],
  timeoutMinutes: 15,
  strategy: {
    "fail-fast": true,
    matrix: fromJSON(needs("prepare").outputs("matrix").toString()) as unknown as Record<string, unknown>,
  },
  steps: [
    Checkout({}).step,
    SetupNode({
      nodeVersion: matrix("node").toString(),
      cache: "npm",
    }).step,
    new Step({ name: "Install", run: "npm ci" }),
    new Step({
      name: "Test shard",
      run: `npm test -- --shard ${matrix("shard")}`,
    }),
  ],
});
