import { Composite, mergeDefaults } from "@intentius/chant";
import { Job, Step, Workflow } from "../generated/index";

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

export const GoCI = Composite((props: GoCIProps) => {
  const {
    goVersion = "1.22",
    testCommand = "go test ./... -v -race",
    buildCommand = "go build ./...",
    lintCommand = "golangci-lint run",
    runsOn = "ubuntu-latest",
    defaults,
  } = props;

  // ── Build job ──────────────────────────────────────────────────────
  const buildJob = new Job(mergeDefaults({
    "runs-on": runsOn,
    steps: [
      new Step({ name: "Checkout", uses: "actions/checkout@v4" }),
      new Step({
        name: "Setup Go",
        uses: "actions/setup-go@v5",
        with: { "go-version": goVersion },
      }),
      new Step({ name: "Build", run: buildCommand }),
    ],
  }, defaults?.buildJob));

  // ── Test job ───────────────────────────────────────────────────────
  const testJob = new Job(mergeDefaults({
    "runs-on": runsOn,
    steps: [
      new Step({ name: "Checkout", uses: "actions/checkout@v4" }),
      new Step({
        name: "Setup Go",
        uses: "actions/setup-go@v5",
        with: { "go-version": goVersion },
      }),
      new Step({ name: "Test", run: testCommand }),
    ],
  }, defaults?.testJob));

  // ── Lint job (optional) ────────────────────────────────────────────
  const lintJob =
    lintCommand !== null
      ? new Job(mergeDefaults({
          "runs-on": runsOn,
          steps: [
            new Step({ name: "Checkout", uses: "actions/checkout@v4" }),
            new Step({
              name: "Setup Go",
              uses: "actions/setup-go@v5",
              with: { "go-version": goVersion },
            }),
            new Step({
              name: "Lint",
              uses: "golangci/golangci-lint-action@v6",
              with: { args: lintCommand },
            }),
          ],
        }, defaults?.lintJob))
      : undefined;

  const workflow = new Workflow(mergeDefaults({
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
