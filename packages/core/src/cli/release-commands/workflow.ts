import type { ReleaseCommandDoc } from "./types";

/** `chant release workflow`: its entry in `chant --help`; the `release` usage line leaves it out. */
export const workflowCommand: ReleaseCommandDoc = {
  name: "workflow",
  helpOrder: 120,
  help: [
    "  release workflow [--forge github|gitlab|forgejo] [--install <command>]",
    "              [--build <command>] [--chant <command>] [--output <file>] [--force]",
    "                        Write the publish workflow, run on the tags",
    "                        release.tag makes (default release/**).",
    "                        Under supply-chain it passes --require-provenance, and",
    "                        under verified-releases it runs release verify first.",
    "                        A file there that chant did not write is replaced",
    "                        only with --force",
  ],
};
