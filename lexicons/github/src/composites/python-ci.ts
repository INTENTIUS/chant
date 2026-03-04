import { Composite } from "@intentius/chant";

export interface PythonCIProps {
  /** Python version. Default: "3.12" */
  pythonVersion?: string;
  /** Test command. Default: "pytest --junitxml=report.xml --cov" */
  testCommand?: string;
  /** Lint command. Set to null to omit lint job. Default: "ruff check ." */
  lintCommand?: string | null;
  /** Requirements file. Default: "requirements.txt" */
  requirementsFile?: string;
  /** Use poetry instead of pip. Default: false */
  usePoetry?: boolean;
  /** Runner label. Default: "ubuntu-latest" */
  runsOn?: string;
}

export const PythonCI = Composite<PythonCIProps>((props) => {
  const {
    pythonVersion = "3.12",
    testCommand = "pytest --junitxml=report.xml --cov",
    lintCommand = "ruff check .",
    requirementsFile = "requirements.txt",
    usePoetry = false,
    runsOn = "ubuntu-latest",
  } = props;

  const { createProperty, createResource } = require("@intentius/chant/runtime");
  const StepClass = createProperty("GitHub::Actions::Step", "github");
  const JobClass = createResource("GitHub::Actions::Job", "github", {});
  const WorkflowClass = createResource("GitHub::Actions::Workflow", "github", {});

  const cacheType = usePoetry ? "poetry" : "pip";
  const installSteps = usePoetry
    ? [
        new StepClass({ name: "Install Poetry", run: "pip install poetry" }),
        new StepClass({ name: "Install dependencies", run: "poetry install" }),
      ]
    : [
        new StepClass({ name: "Install dependencies", run: `pip install -r ${requirementsFile}` }),
      ];

  // ── Test job ───────────────────────────────────────────────────────
  const testJob = new JobClass({
    "runs-on": runsOn,
    steps: [
      new StepClass({ name: "Checkout", uses: "actions/checkout@v4" }),
      new StepClass({
        name: "Setup Python",
        uses: "actions/setup-python@v5",
        with: { "python-version": pythonVersion, cache: cacheType },
      }),
      ...installSteps,
      new StepClass({ name: "Test", run: testCommand }),
    ],
  });

  // ── Lint job (optional) ────────────────────────────────────────────
  const lintJob =
    lintCommand !== null
      ? new JobClass({
          "runs-on": runsOn,
          steps: [
            new StepClass({ name: "Checkout", uses: "actions/checkout@v4" }),
            new StepClass({
              name: "Setup Python",
              uses: "actions/setup-python@v5",
              with: { "python-version": pythonVersion, cache: cacheType },
            }),
            ...installSteps.map((s: any) => {
              // Create fresh step instances for the lint job
              return new StepClass({ name: s.props.name, run: s.props.run });
            }),
            new StepClass({ name: "Lint", run: lintCommand }),
          ],
        })
      : undefined;

  // ── Workflow ───────────────────────────────────────────────────────
  const workflow = new WorkflowClass({
    name: "Python CI",
    on: {
      push: { branches: ["main"] },
      pull_request: { branches: ["main"] },
    },
  });

  if (lintJob) {
    return { workflow, testJob, lintJob };
  }
  return { workflow, testJob } as any;
}, "PythonCI");
