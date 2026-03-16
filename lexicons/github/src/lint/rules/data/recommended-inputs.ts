/**
 * Recommended inputs for setup action composites.
 * If a setup action is used without any of the listed inputs, a warning is raised.
 */

export const recommendedInputs: Record<string, string[]> = {
  SetupNode: ["nodeVersion", "node-version"],
  SetupGo: ["goVersion", "go-version"],
  SetupPython: ["pythonVersion", "python-version"],
};
