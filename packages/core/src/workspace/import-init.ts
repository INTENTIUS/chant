/**
 * `chant workspace init --from tfc|spacelift|backstage` (#3178): the command
 * around `import-source.ts`. It reads the source, prints the proposal and what
 * was left out, and writes only on confirmation, as `init` does (#2525 rule 1).
 * Besides `chant.workspace.json` it writes `chant-import.<source>.json`: the
 * environments and constraint records the declaration has no field for.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { formatError, formatSuccess } from "../cli/format";
import type { CommandContext } from "../cli/registry";
import { fetchSpacelift, fetchTfc, ImportFetchError, type Fetcher } from "./import-fetch";
import {
  IMPORT_SOURCES,
  proposeFromBackstage,
  proposeFromSpacelift,
  proposeFromTfc,
  readInputFile,
  type ImportProposal,
  type ImportSource,
  type SpaceliftInput,
  type TfcInput,
} from "./import-source";
import { WorkspaceReadError } from "./declaration";
import { terraformToken } from "../terraform/credentials";

export const IMPORT_USAGE =
  "chant workspace init --from tfc --org <organization> [--input <export.json>] [--token <token>] [dir] [--name <name>] [--yes]\n" +
  "       chant workspace init --from spacelift --endpoint <https://acme.app.spacelift.io/graphql> [--input <export.json>] [--token <token>] [dir] [--yes]\n" +
  "       chant workspace init --from backstage [dir] [--name <name>] [--yes]";

export const isImportSource = (v: string | undefined): v is ImportSource => (IMPORT_SOURCES as readonly string[]).includes(v ?? "");

export interface ImportDeps {
  /** For tests: the transport the API readers use. */
  fetcher?: Fetcher;
  env?: Record<string, string | undefined>;
  /** For tests: answers the confirmation. */
  confirm?: (question: string) => Promise<boolean>;
  isTTY?: boolean;
}

/** Read the source into a proposal. Throws {@link ImportFetchError} or an Error naming what is missing. */
export async function loadProposal(source: ImportSource, root: string, args: CommandContext["args"], deps: ImportDeps = {}): Promise<ImportProposal> {
  const env = deps.env ?? process.env;
  if (source === "backstage") return proposeFromBackstage(root, { name: args.selectName });
  if (source === "tfc") {
    let input: TfcInput;
    if (args.input) input = readInputFile("tfc", resolve(args.input)) as TfcInput;
    else {
      // The CLIs' lookup (chant#4563): TF_TOKEN_app_terraform_io, then the CLI config and credentials.tfrc.json.
      const token = args.token ?? env.TFE_TOKEN ?? terraformToken("app.terraform.io", { env });
      if (!token) throw new Error("--from tfc needs --input <export.json>, or a token in --token, TFE_TOKEN, TF_TOKEN_app_terraform_io or credentials.tfrc.json");
      if (!args.org) throw new Error("--from tfc needs --org <organization>");
      input = await fetchTfc({ organization: args.org, token, fetcher: deps.fetcher });
    }
    return proposeFromTfc(input, { name: args.selectName });
  }
  let input: SpaceliftInput;
  if (args.input) input = readInputFile("spacelift", resolve(args.input)) as SpaceliftInput;
  else {
    const token = args.token ?? env.SPACELIFT_API_TOKEN;
    if (!token) throw new Error("--from spacelift needs --input <export.json>, or a token in --token or SPACELIFT_API_TOKEN");
    if (!args.endpoint) throw new Error("--from spacelift needs --endpoint <https://<account>.app.spacelift.io/graphql>");
    input = await fetchSpacelift({ endpoint: args.endpoint, token, fetcher: deps.fetcher });
  }
  return proposeFromSpacelift(input, { name: args.selectName });
}

export function formatImportProposal(p: ImportProposal): string[] {
  const lines: string[] = [];
  const links = p.declaration.members.reduce((n, m) => n + (m.links?.length ?? 0), 0);
  lines.push(`${p.declaration.members.length} member(s), ${links} link(s), ${p.environments.length} environment(s), ${p.records.length} constraint record(s).`);
  if (p.environments.length > 0) {
    lines.push("", "Environments:");
    for (const e of p.environments) lines.push(`  ${e.name}: ${e.members.join(", ")}`);
  }
  if (p.records.length > 0) {
    lines.push("", "Constraint records:");
    for (const r of p.records) lines.push(`  ${r.id}${r.policyKind ? ` (${r.policyKind})` : ""} applies to ${r.appliesTo.length === 0 ? "every member" : r.appliesTo.join(", ")}`);
  }
  lines.push("", "Left out:");
  if (p.leftOut.length === 0) lines.push("  nothing");
  for (const l of p.leftOut) lines.push(`  ${l.count} ${l.what}: ${l.why}`);
  for (const n of p.notes) lines.push("", n);
  return lines;
}

async function defaultConfirm(question: string): Promise<boolean> {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((done) => {
    rl.question(question, (a) => {
      done(/^y(es)?$/i.test(a.trim()));
      rl.close();
    });
    rl.on("close", () => done(false));
  });
}

export async function runImportInit(source: ImportSource, root: string, args: CommandContext["args"], deps: ImportDeps = {}): Promise<number> {
  let proposal: ImportProposal;
  try {
    proposal = await loadProposal(source, root, args, deps);
  } catch (err) {
    if (err instanceof WorkspaceReadError) {
      console.error(formatError({ message: `the proposed declaration is not valid: ${err.describe()}`, hint: "Write chant.workspace.json by hand for now." }));
      return 1;
    }
    console.error(formatError({ message: err instanceof Error ? err.message : String(err), hint: IMPORT_USAGE }));
    return 1;
  }

  const target = join(root, "chant.workspace.json");
  const sidecar = join(root, `chant-import.${source}.json`);
  const text = `${JSON.stringify(proposal.declaration, null, 2)}\n`;
  const sideText = `${JSON.stringify({ source, environments: proposal.environments, records: proposal.records, leftOut: proposal.leftOut }, null, 2)}\n`;
  console.log(`Proposed ${target}:`);
  console.log("");
  console.log(text);
  for (const line of formatImportProposal(proposal)) console.log(line);
  console.log("");
  console.log(`Confirming also writes ${sidecar}, holding the environments, constraint records and the left-out list.`);
  console.log("");

  let write = !!args.yes;
  if (!write) {
    if (!(deps.isTTY ?? process.stdin.isTTY)) {
      console.log("Nothing written. Re-run with --yes to write it, or save the proposal above and edit it first.");
      return 0;
    }
    write = await (deps.confirm ?? defaultConfirm)("Write chant.workspace.json? [y/N] ");
  }
  if (!write) {
    console.log("Nothing written.");
    return 0;
  }
  if (existsSync(sidecar)) {
    console.error(formatError({ message: `${sidecar} already exists`, hint: "Move it aside and run again." }));
    return 1;
  }
  writeFileSync(target, text, { flag: "wx" });
  writeFileSync(sidecar, sideText, { flag: "wx" });
  console.log(formatSuccess(`Wrote ${target} and ${sidecar}. chant workspace ls lists what it declares.`));
  return 0;
}

export { ImportFetchError };
