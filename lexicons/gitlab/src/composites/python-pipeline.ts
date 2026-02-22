import { Composite } from "@intentius/chant";
import { Job, Default, Image, Cache, Artifacts } from "../generated";
import { CI } from "../variables";

export interface PythonPipelineProps {
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
}

export const PythonPipeline = Composite<PythonPipelineProps>((props) => {
  const {
    pythonVersion = "3.12",
    testCommand = "pytest --junitxml=report.xml --cov",
    lintCommand = "ruff check .",
    requirementsFile = "requirements.txt",
    usePoetry = false,
  } = props;

  const pythonImage = new Image({ name: `python:${pythonVersion}-slim` });

  const cache = new Cache({
    key: { files: [usePoetry ? "poetry.lock" : requirementsFile] },
    paths: [".pip-cache/", ".venv/"],
    policy: "pull-push",
  });

  const installSteps = usePoetry
    ? ["pip install poetry", "poetry config virtualenvs.in-project true", "poetry install"]
    : [
        "python -m venv .venv",
        "source .venv/bin/activate",
        `pip install -r ${requirementsFile}`,
      ];

  const activateStep = usePoetry ? "source .venv/bin/activate" : "source .venv/bin/activate";

  const defaults = new Default({
    image: pythonImage,
    cache: [cache],
    before_script: [...installSteps],
  });

  const test = new Job({
    stage: "test",
    variables: { PIP_CACHE_DIR: `${CI.ProjectDir}/.pip-cache` },
    script: [activateStep, testCommand],
    artifacts: new Artifacts({
      reports: { junit: "report.xml" },
      when: "always",
    }),
  });

  const lint =
    lintCommand !== null
      ? new Job({
          stage: "test",
          variables: { PIP_CACHE_DIR: `${CI.ProjectDir}/.pip-cache` },
          script: [activateStep, lintCommand],
        })
      : undefined;

  if (lint) {
    return { defaults, test, lint };
  }

  return { defaults, test } as any;
}, "PythonPipeline");
