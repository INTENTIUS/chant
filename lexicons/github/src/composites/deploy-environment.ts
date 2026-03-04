import { Composite } from "@intentius/chant";

export interface DeployEnvironmentProps {
  /** Environment name. Required. */
  name: string;
  /** Deploy command(s). Required. */
  deployScript: string | string[];
  /** Cleanup command(s). Default: 'echo "Cleaning up..."' */
  cleanupScript?: string | string[];
  /** Environment URL */
  url?: string;
  /** Concurrency group. Default: "deploy-{name}" */
  concurrencyGroup?: string;
  /** Cancel in-progress deploys. Default: true */
  cancelInProgress?: boolean;
  /** Runner label. Default: "ubuntu-latest" */
  runsOn?: string;
}

export const DeployEnvironment = Composite<DeployEnvironmentProps>((props) => {
  const {
    name,
    deployScript,
    cleanupScript = 'echo "Cleaning up..."',
    url,
    concurrencyGroup,
    cancelInProgress = true,
    runsOn = "ubuntu-latest",
  } = props;

  const group = concurrencyGroup ?? `deploy-${name}`;
  const deployScriptArr = Array.isArray(deployScript) ? deployScript : [deployScript];
  const cleanupScriptArr = Array.isArray(cleanupScript) ? cleanupScript : [cleanupScript];

  const { createProperty, createResource } = require("@intentius/chant/runtime");
  const StepClass = createProperty("GitHub::Actions::Step", "github");
  const JobClass = createResource("GitHub::Actions::Job", "github", {});

  // ── Deploy job ─────────────────────────────────────────────────────
  const deploySteps = [
    new StepClass({ name: "Checkout", uses: "actions/checkout@v4" }),
    ...deployScriptArr.map(
      (cmd: string) => new StepClass({ name: "Deploy", run: cmd }),
    ),
  ];

  const environment: Record<string, string> = { name };
  if (url) {
    environment.url = url;
  }

  const deployJob = new JobClass({
    "runs-on": runsOn,
    environment,
    concurrency: {
      group,
      "cancel-in-progress": cancelInProgress,
    },
    steps: deploySteps,
  });

  // ── Cleanup job ────────────────────────────────────────────────────
  const cleanupSteps = [
    new StepClass({ name: "Checkout", uses: "actions/checkout@v4" }),
    ...cleanupScriptArr.map(
      (cmd: string) => new StepClass({ name: "Cleanup", run: cmd }),
    ),
  ];

  const cleanupJob = new JobClass({
    "runs-on": runsOn,
    environment: { name },
    steps: cleanupSteps,
  });

  return { deployJob, cleanupJob };
}, "DeployEnvironment");
