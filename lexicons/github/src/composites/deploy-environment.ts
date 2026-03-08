import { Composite, mergeDefaults } from "@intentius/chant";
import type { Job } from "../generated/index";

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
  defaults?: {
    deployJob?: Partial<ConstructorParameters<typeof Job>[0]>;
    cleanupJob?: Partial<ConstructorParameters<typeof Job>[0]>;
  };
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
    defaults,
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

  const deployJob = new JobClass(mergeDefaults({
    "runs-on": runsOn,
    environment,
    concurrency: {
      group,
      "cancel-in-progress": cancelInProgress,
    },
    steps: deploySteps,
  }, defaults?.deployJob));

  // ── Cleanup job ────────────────────────────────────────────────────
  const cleanupSteps = [
    new StepClass({ name: "Checkout", uses: "actions/checkout@v4" }),
    ...cleanupScriptArr.map(
      (cmd: string) => new StepClass({ name: "Cleanup", run: cmd }),
    ),
  ];

  const cleanupJob = new JobClass(mergeDefaults({
    "runs-on": runsOn,
    environment: { name },
    steps: cleanupSteps,
  }, defaults?.cleanupJob));

  return { deployJob, cleanupJob };
}, "DeployEnvironment");
