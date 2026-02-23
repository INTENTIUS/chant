import { PythonPipeline } from "@intentius/chant-lexicon-gitlab";

export const app = PythonPipeline({
  pythonVersion: "3.12",
  lintCommand: null,
});
