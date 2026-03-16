import { Composite, mergeDefaults } from "@intentius/chant";
import type { Job, Workflow } from "../generated/index";

export interface NodeCIProps {
  nodeVersion?: string;
  packageManager?: "npm" | "pnpm" | "yarn" | "bun";
  buildScript?: string;
  testScript?: string;
  installCommand?: string;
  defaults?: {
    job?: Partial<ConstructorParameters<typeof Job>[0]>;
    workflow?: Partial<ConstructorParameters<typeof Workflow>[0]>;
  };
}

export const NodeCI = Composite<NodeCIProps>((props) => {
  const {
    nodeVersion = "22",
    packageManager = "npm",
    buildScript = "build",
    testScript = "test",
    installCommand,
    defaults,
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

  const job = new JobClass(mergeDefaults({
    "runs-on": "ubuntu-latest",
    steps: [checkoutStep, setupNodeStep, installStep, buildStep, testStep],
  }, defaults?.job));

  const workflow = new WorkflowClass(mergeDefaults({
    name: "CI",
    on: {
      push: { branches: ["main"] },
      pull_request: { branches: ["main"] },
    },
  }, defaults?.workflow));

  return { workflow, job };
}, "NodeCI");
