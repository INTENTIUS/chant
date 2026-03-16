/**
 * Registry of well-known GitHub Actions and their typed composite wrappers.
 */

export const knownActions: Record<string, { composite: string; importPath: string }> = {
  "actions/checkout": { composite: "Checkout", importPath: "@intentius/chant-lexicon-github" },
  "actions/setup-node": { composite: "SetupNode", importPath: "@intentius/chant-lexicon-github" },
  "actions/setup-go": { composite: "SetupGo", importPath: "@intentius/chant-lexicon-github" },
  "actions/setup-python": { composite: "SetupPython", importPath: "@intentius/chant-lexicon-github" },
  "actions/cache": { composite: "Cache", importPath: "@intentius/chant-lexicon-github" },
  "actions/upload-artifact": { composite: "UploadArtifact", importPath: "@intentius/chant-lexicon-github" },
  "actions/download-artifact": { composite: "DownloadArtifact", importPath: "@intentius/chant-lexicon-github" },
};
