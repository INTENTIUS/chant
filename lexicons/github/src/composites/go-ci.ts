import { Composite, mergeDefaults } from "@intentius/chant";
import type { Job, Workflow } from "../generated/index";

export interface GoCIProps {
  /** Go version. Default: "1.22" */
  goVersion?: string;
  /** Test command. Default: "go test ./... -v -race" */
  testCommand?: string;
  /** Build command. Default: "go build ./..." */
  buildCommand?: string;
  /** Lint command. Set to null to omit lint job. Default: "golangci-lint run" */
  lintCommand?: string | null;
  /** Runner label. Default: "ubuntu-latest" */
  runsOn?: string;
  defaults?: {
    buildJob?: Partial<ConstructorParameters<typeof Job>[0]>;
    testJob?: Partial<ConstructorParameters<typeof Job>[0]>;
    lintJob?: Partial<ConstructorParameters<typeof Job>[0]>;
    workflow?: Partial<ConstructorParameters<typeof Workflow>[0]>;
  };
}

export const GoCI = Composite<GoCIProps>((props) => {
  const {
    goVersion = "1.22",
    testCommand = "go test ./... -v -race",
    buildCommand = "go build ./...",
    lintCommand = "golangci-lint run",
    runsOn = "ubuntu-latest",
    defaults,
  } = props;

  const { createProperty, createResource } = require("@intentius/chant/runtime");
  const StepClass = createProperty("GitHub::Actions::Step", "github");
  const JobClass = createResource("GitHub::Actions::Job", "github", {});
  const WorkflowClass = createResource("GitHub::Actions::Workflow", "github", {});

  // ── Build job ──────────────────────────────────────────────────────
  const buildJob = new JobClass(mergeDefaults({
    "runs-on": runsOn,
    steps: [
      new StepClass({ name: "Checkout", uses: "actions/checkout@v4" }),
      new StepClass({
        name: "Setup Go",
        uses: "actions/setup-go@v5",
        with: { "go-version": goVersion },
      }),
      new StepClass({ name: "Build", run: buildCommand }),
    ],
  }, defaults?.buildJob));

  // ── Test job ───────────────────────────────────────────────────────
  const testJob = new JobClass(mergeDefaults({
    "runs-on": runsOn,
    steps: [
      new StepClass({ name: "Checkout", uses: "actions/checkout@v4" }),
      new StepClass({
        name: "Setup Go",
        uses: "actions/setup-go@v5",
        with: { "go-version": goVersion },
      }),
      new StepClass({ name: "Test", run: testCommand }),
    ],
  }, defaults?.testJob));

  // ── Lint job (optional) ────────────────────────────────────────────
  const lintJob =
    lintCommand !== null
      ? new JobClass(mergeDefaults({
          "runs-on": runsOn,
          steps: [
            new StepClass({ name: "Checkout", uses: "actions/checkout@v4" }),
            new StepClass({
              name: "Setup Go",
              uses: "actions/setup-go@v5",
              with: { "go-version": goVersion },
            }),
            new StepClass({
              name: "Lint",
              uses: "golangci/golangci-lint-action@v6",
              with: { args: lintCommand },
            }),
          ],
        }, defaults?.lintJob))
      : undefined;

  const workflow = new WorkflowClass(mergeDefaults({
    name: "Go CI",
    on: {
      push: { branches: ["main"] },
      pull_request: { branches: ["main"] },
    },
  }, defaults?.workflow));

  if (lintJob) {
    return { workflow, buildJob, testJob, lintJob };
  }
  return { workflow, buildJob, testJob } as any;
}, "GoCI");
