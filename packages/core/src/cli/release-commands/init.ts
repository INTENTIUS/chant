import type { ReleaseCommandDoc } from "./types";

/** `chant release init`: its entry in `chant --help` and the `release` usage line. */
export const initCommand: ReleaseCommandDoc = {
  name: "init",
  helpOrder: 110,
  help: [
    "  release init [--yes] [--force] [--one-release] [--forge github|gitlab|forgejo] [--json]",
    "                        Set up chant release in a project: detect its packages,",
    "                        images and tags, write release in chant.config.ts and",
    "                        the release workflow, and list the registry steps to",
    "                        take by hand (chant.config.json when tsx is not",
    "                        installed). A workflow that runs npm publish becomes",
    "                        the release workflow, so npm's trusted publisher",
    "                        keeps naming it. A workspace with several npm packages",
    "                        gets a release train, a member per package, unless",
    "                        --one-release. A dry run unless --yes; --force replaces",
    "                        an existing release block.",
  ],
  usage: { order: 120, text: "release init [--yes] [--force] [--one-release] [--forge github|gitlab|forgejo] [--json]" },
};
