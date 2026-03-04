import { Composite, withDefaults } from "@intentius/chant";

export interface NodePipelineProps {
  /** Node.js version. Default: "22" */
  nodeVersion?: string;
  /** Package manager. Default: "npm" */
  packageManager?: "npm" | "pnpm" | "yarn" | "bun";
  /** Build script name. Default: "build" */
  buildScript?: string;
  /** Test script name. Default: "test" */
  testScript?: string;
  /** Override auto-detected install command */
  installCommand?: string;
  /** Build artifact paths. Default: ["dist/"] */
  buildArtifactPaths?: string[];
  /** Artifact name. Default: "build-output" */
  artifactName?: string;
  /** Artifact retention days. Default: 1 */
  artifactRetentionDays?: number;
  /** Runner label. Default: "ubuntu-latest" */
  runsOn?: string;
}

const cacheConfig = {
  npm: {
    cache: "npm",
    installCmd: "npm ci",
    runPrefix: "npm run",
    setupAction: "actions/setup-node@v4",
  },
  pnpm: {
    cache: "pnpm",
    installCmd: "pnpm install --frozen-lockfile",
    runPrefix: "pnpm run",
    setupAction: "actions/setup-node@v4",
  },
  yarn: {
    cache: "yarn",
    installCmd: "yarn install --frozen-lockfile",
    runPrefix: "yarn",
    setupAction: "actions/setup-node@v4",
  },
  bun: {
    cache: undefined,
    installCmd: "bun install --frozen-lockfile",
    runPrefix: "bun run",
    setupAction: "oven-sh/setup-bun@v2",
  },
} as const;

export const NodePipeline = Composite<NodePipelineProps>((props) => {
  const {
    nodeVersion = "22",
    packageManager = "npm",
    buildScript = "build",
    testScript = "test",
    installCommand,
    buildArtifactPaths = ["dist/"],
    artifactName = "build-output",
    artifactRetentionDays = 1,
    runsOn = "ubuntu-latest",
  } = props;

  const pm = cacheConfig[packageManager];
  const install = installCommand ?? pm.installCmd;
  const run = pm.runPrefix;

  const { createProperty, createResource } = require("@intentius/chant/runtime");
  const StepClass = createProperty("GitHub::Actions::Step", "github");
  const JobClass = createResource("GitHub::Actions::Job", "github", {});
  const WorkflowClass = createResource("GitHub::Actions::Workflow", "github", {});

  const isBun = packageManager === "bun";

  // ── Build job steps ────────────────────────────────────────────────
  const buildCheckout = new StepClass({ name: "Checkout", uses: "actions/checkout@v4" });

  const buildSetup = isBun
    ? new StepClass({ name: "Setup Bun", uses: "oven-sh/setup-bun@v2" })
    : new StepClass({
        name: "Setup Node.js",
        uses: "actions/setup-node@v4",
        with: { "node-version": nodeVersion, cache: pm.cache },
      });

  const buildInstall = new StepClass({ name: "Install dependencies", run: install });

  const buildRun = new StepClass({ name: "Build", run: `${run} ${buildScript}` });

  const buildUpload = new StepClass({
    name: "Upload build artifacts",
    uses: "actions/upload-artifact@v4",
    with: {
      name: artifactName,
      path: buildArtifactPaths.join("\n"),
      "retention-days": String(artifactRetentionDays),
    },
  });

  const buildJob = new JobClass({
    "runs-on": runsOn,
    steps: [buildCheckout, buildSetup, buildInstall, buildRun, buildUpload],
  });

  // ── Test job steps ─────────────────────────────────────────────────
  const testCheckout = new StepClass({ name: "Checkout", uses: "actions/checkout@v4" });

  const testSetup = isBun
    ? new StepClass({ name: "Setup Bun", uses: "oven-sh/setup-bun@v2" })
    : new StepClass({
        name: "Setup Node.js",
        uses: "actions/setup-node@v4",
        with: { "node-version": nodeVersion, cache: pm.cache },
      });

  const testInstall = new StepClass({ name: "Install dependencies", run: install });

  const testDownload = new StepClass({
    name: "Download build artifacts",
    uses: "actions/download-artifact@v4",
    with: { name: artifactName },
  });

  const testRun = new StepClass({ name: "Test", run: `${run} ${testScript}` });

  const testJob = new JobClass({
    "runs-on": runsOn,
    needs: ["build"],
    steps: [testCheckout, testSetup, testInstall, testDownload, testRun],
  });

  // ── Workflow ───────────────────────────────────────────────────────
  const workflow = new WorkflowClass({
    name: "Node Pipeline",
    on: {
      push: { branches: ["main"] },
      pull_request: { branches: ["main"] },
    },
  });

  return { workflow, buildJob, testJob };
}, "NodePipeline");

/** NodePipeline preset for Bun projects. */
export const BunPipeline = withDefaults(NodePipeline, { packageManager: "bun" as const });

/** NodePipeline preset for pnpm projects. */
export const PnpmPipeline = withDefaults(NodePipeline, { packageManager: "pnpm" as const });

/** NodePipeline preset for Yarn projects. */
export const YarnPipeline = withDefaults(NodePipeline, { packageManager: "yarn" as const });
