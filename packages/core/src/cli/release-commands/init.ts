import type { ReleaseCommandDoc } from "./types";

/** `chant release init`: its entry in `chant --help` and the `release` usage line. */
export const initCommand: ReleaseCommandDoc = {
  name: "init",
  helpOrder: 110,
  help: [
    "  release init [--yes] [--force] [--forge github|gitlab|forgejo] [--json]",
    "                        Set up chant release in a project: detect its packages,",
    "                        images and tags, write release in chant.config.ts and",
    "                        the release workflow, and list the registry steps to",
    "                        take by hand. A dry run unless --yes; --force replaces",
    "                        an existing release block.",
  ],
  usage: { order: 120, text: "release init [--yes] [--force] [--forge github|gitlab|forgejo] [--json]" },
};
