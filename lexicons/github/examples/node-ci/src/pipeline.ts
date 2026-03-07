import {
  Workflow, Job, Step,
  Checkout, SetupNode, CacheAction,
  matrix,
} from "@intentius/chant-lexicon-github";

export const workflow = new Workflow({
  name: "Node.js CI",
  on: {
    push: { branches: ["main"] },
    pull_request: { branches: ["main"] },
  },
  permissions: { contents: "read" },
});

export const ci = new Job({
  "runs-on": "ubuntu-latest",
  timeoutMinutes: 15,
  strategy: {
    matrix: {
      "node-version": ["18", "20", "22"],
    },
    "fail-fast": false,
  },
  steps: [
    Checkout({}).step,
    SetupNode({
      nodeVersion: matrix("node-version").toString(),
      cache: "npm",
    }).step,
    CacheAction({
      path: "~/.npm",
      key: `\${{ runner.os }}-node-\${{ matrix.node-version }}-\${{ hashFiles('**/package-lock.json') }}`,
      restoreKeys: [
        "${{ runner.os }}-node-${{ matrix.node-version }}-",
        "${{ runner.os }}-node-",
      ],
    }).step,
    new Step({ name: "Install", run: "npm ci" }),
    new Step({ name: "Lint", run: "npm run lint" }),
    new Step({ name: "Test", run: "npm test" }),
    new Step({ name: "Build", run: "npm run build" }),
  ],
});
