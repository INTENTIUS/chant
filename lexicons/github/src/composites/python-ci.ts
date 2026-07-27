import { Composite, mergeDefaults } from "@intentius/chant";
import { Job, Step, Workflow } from "../generated/index";

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
  defaults?: {
    testJob?: Partial<ConstructorParameters<typeof Job>[0]>;
    lintJob?: Partial<ConstructorParameters<typeof Job>[0]>;
    workflow?: Partial<ConstructorParameters<typeof Workflow>[0]>;
  };
}

export const PythonCI = Composite<PythonCIProps>((props) => {
  const {
    pythonVersion = "3.12",
    testCommand = "pytest --junitxml=report.xml --cov",
    lintCommand = "ruff check .",
    requirementsFile = "requirements.txt",
    usePoetry = false,
    runsOn = "ubuntu-latest",
    defaults,
  } = props;

  const cacheType = usePoetry ? "poetry" : "pip";
  const installSteps = usePoetry
    ? [
        new Step({ name: "Install Poetry", run: "pip install poetry" }),
        new Step({ name: "Install dependencies", run: "poetry install" }),
      ]
    : [
        new Step({ name: "Install dependencies", run: `pip install -r ${requirementsFile}` }),
      ];

  // ── Test job ───────────────────────────────────────────────────────
  const testJob = new Job(mergeDefaults({
    "runs-on": runsOn,
    steps: [
      new Step({ name: "Checkout", uses: "actions/checkout@v4" }),
      new Step({
        name: "Setup Python",
        uses: "actions/setup-python@v5",
        with: { "python-version": pythonVersion, cache: cacheType },
      }),
      ...installSteps,
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
              name: "Setup Python",
              uses: "actions/setup-python@v5",
              with: { "python-version": pythonVersion, cache: cacheType },
            }),
            ...installSteps.map((s: any) => {
              // Create fresh step instances for the lint job
              return new Step({ name: s.props.name, run: s.props.run });
            }),
            new Step({ name: "Lint", run: lintCommand }),
          ],
        }, defaults?.lintJob))
      : undefined;

  // ── Workflow ───────────────────────────────────────────────────────
  const workflow = new Workflow(mergeDefaults({
    name: "Python CI",
    on: {
      push: { branches: ["main"] },
      pull_request: { branches: ["main"] },
    },
  }, defaults?.workflow));

  if (lintJob) {
    return { workflow, testJob, lintJob };
  }
  return { workflow, testJob } as any;
}, "PythonCI");
