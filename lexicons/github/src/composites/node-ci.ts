import { Composite, mergeDefaults } from "@intentius/chant";
import { Job, Step, Workflow } from "../generated/index";

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

export const NodeCI = Composite((props: NodeCIProps) => {
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

  const checkoutStep = new Step({
    name: "Checkout",
    uses: "actions/checkout@v4",
  });

  const setupNodeStep = new Step({
    name: "Setup Node.js",
    uses: "actions/setup-node@v4",
    with: {
      "node-version": nodeVersion,
      cache: packageManager === "bun" ? undefined : packageManager,
    },
  });

  const installStep = new Step({
    name: "Install dependencies",
    run: install,
  });

  const buildStep = new Step({
    name: "Build",
    run: `${run} ${buildScript}`,
  });

  const testStep = new Step({
    name: "Test",
    run: `${run} ${testScript}`,
  });

  const job = new Job(mergeDefaults({
    "runs-on": "ubuntu-latest",
    steps: [checkoutStep, setupNodeStep, installStep, buildStep, testStep],
  }, defaults?.job));

  const workflow = new Workflow(mergeDefaults({
    name: "CI",
    on: {
      push: { branches: ["main"] },
      pull_request: { branches: ["main"] },
    },
  }, defaults?.workflow));

  return { workflow, job };
}, "NodeCI");
