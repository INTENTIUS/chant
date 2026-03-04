import { Composite } from "@intentius/chant";

export interface NodeCIProps {
  nodeVersion?: string;
  packageManager?: "npm" | "pnpm" | "yarn" | "bun";
  buildScript?: string;
  testScript?: string;
  installCommand?: string;
}

export const NodeCI = Composite<NodeCIProps>((props) => {
  const {
    nodeVersion = "22",
    packageManager = "npm",
    buildScript = "build",
    testScript = "test",
    installCommand,
  } = props;

  const install = installCommand ?? (packageManager === "npm" ? "npm ci" : `${packageManager} install`);
  const run = packageManager === "npm" ? "npm run" : packageManager;

  const { createProperty, createResource } = require("@intentius/chant/runtime");
  const StepClass = createProperty("GitHub::Actions::Step", "github");
  const JobClass = createResource("GitHub::Actions::Job", "github", {});
  const WorkflowClass = createResource("GitHub::Actions::Workflow", "github", {});

  const checkoutStep = new StepClass({
    name: "Checkout",
    uses: "actions/checkout@v4",
  });

  const setupNodeStep = new StepClass({
    name: "Setup Node.js",
    uses: "actions/setup-node@v4",
    with: {
      "node-version": nodeVersion,
      cache: packageManager === "bun" ? undefined : packageManager,
    },
  });

  const installStep = new StepClass({
    name: "Install dependencies",
    run: install,
  });

  const buildStep = new StepClass({
    name: "Build",
    run: `${run} ${buildScript}`,
  });

  const testStep = new StepClass({
    name: "Test",
    run: `${run} ${testScript}`,
  });

  const job = new JobClass({
    "runs-on": "ubuntu-latest",
    steps: [checkoutStep, setupNodeStep, installStep, buildStep, testStep],
  });

  const workflow = new WorkflowClass({
    name: "CI",
    on: {
      push: { branches: ["main"] },
      pull_request: { branches: ["main"] },
    },
  });

  return { workflow, job };
}, "NodeCI");
