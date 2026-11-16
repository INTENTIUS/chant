/**
 * Every `chant release` subcommand's help entry and usage form (#5196),
 * one file each. The usage line and the Releases section of `chant --help`
 * are built from these, in each entry's order, so adding a subcommand adds a
 * file here and one line to the list below, kept in alphabetical order.
 */
import { artifactsCommand } from "./artifacts";
import { candidatesCommand } from "./candidates";
import { changedCommand } from "./changed";
import { composeCommand } from "./compose";
import { cutCommand } from "./cut";
import { doctorCommand } from "./doctor";
import { exportCommand } from "./export";
import { imagesCommand } from "./images";
import { initCommand } from "./init";
import { listCommand } from "./list";
import { nextCommand } from "./next";
import { publishCommand } from "./publish";
import { stampCommand } from "./stamp";
import { statusCommand } from "./status";
import { tagCommand } from "./tag";
import { verifyCommand } from "./verify";
import { workflowCommand } from "./workflow";
import type { ReleaseCommandDoc } from "./types";

export type { ReleaseCommandDoc } from "./types";

/** Every subcommand, alphabetically by file. */
export const RELEASE_COMMANDS: readonly ReleaseCommandDoc[] = [
  artifactsCommand,
  candidatesCommand,
  changedCommand,
  composeCommand,
  cutCommand,
  doctorCommand,
  exportCommand,
  imagesCommand,
  initCommand,
  listCommand,
  nextCommand,
  publishCommand,
  stampCommand,
  statusCommand,
  tagCommand,
  verifyCommand,
  workflowCommand,
];

/** The usage line `chant release` prints with a refusal: every subcommand's form, in usage order, after `chant `. */
export function releaseUsage(commands: readonly ReleaseCommandDoc[] = RELEASE_COMMANDS): string {
  const forms = commands.filter((c) => c.usage !== undefined).sort((a, b) => a.usage!.order - b.usage!.order);
  return `chant ${forms.map((c) => c.usage!.text).join(" | ")}`;
}

/** The Releases section's entries of `chant --help`, in help order, without a trailing newline. */
export function releaseHelp(commands: readonly ReleaseCommandDoc[] = RELEASE_COMMANDS): string {
  return [...commands].sort((a, b) => a.helpOrder - b.helpOrder).flatMap((c) => c.help).join("\n");
}
