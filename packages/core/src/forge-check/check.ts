/**
 * The forge check (#4608): a contract (./contract.ts) next to the live
 * forge, the clouds and Pulumi Cloud, one row per expected setting.
 *
 * Statuses: `match`, `mismatch`, `unknown` (the setting could not be read)
 * and `not-checked` (no credentials for that cloud). Only a mismatch fails,
 * and with `requireClouds` a cloud left unchecked. The exit code is chant's
 * `failed` then, else `done` (../exit-codes.ts).
 *
 * The product's words name the command in messages and the result's schema
 * (`terragucci.forge-check/v1`, `plywood.forge-check/v1`), so `terragucci
 * forge check`, `plywood forge check` and `chant ci forge-check` call this
 * one function.
 */

import { IDENTITY_CLOUDS, type IdentityCloud } from "../ci-identity";
import { resolveProductWords, type CiProductWords, type CiProductWordsInput } from "../ci-product-words";
import { CHANT_EXIT } from "../exit-codes";
import { FORGE_TOKEN_ORDER, type ForgeKind, type ForgeTarget } from "../pr-forge";
import type { ForgeCheckContract, LiveRepository } from "./contract";
import { forgejoRows, githubRows, gitlabRows, readRepository, statusReportedRows } from "./forge";
import { pulumiRows } from "./pulumi";
import { readOnly } from "./read-only";
import { awsRows, azureRows, gcpRows } from "./trust";
import { CHECK_STATUSES, couldNot, SCOPES, type CheckRow, type CheckStatus, type ForgeCheckDeps, type ForgeCheckResult } from "./types";

/** The command a product's words name: `chant ci forge-check`, or `<product> forge check`. */
export const forgeCheckCommand = (words: CiProductWords): string => (words.product === "chant" ? "chant ci forge-check" : `${words.product} forge check`);

/** The result's schema for a product. */
export const forgeCheckSchema = (words: CiProductWords): string => `${words.product}.forge-check/v1`;

export interface ForgeCheckInput {
  /** The forge, its REST base and a token (`forgeCheckTarget`, or `forgeTargetFromEnv` in ../pr-forge.ts). */
  target: ForgeTarget;
  /**
   * The contract, or a function that builds it once the repository's own
   * default branch, path and (Forgejo) numeric ids are read, since the jobs'
   * subjects hold them.
   */
  contract: ForgeCheckContract | ((live: LiveRepository) => ForgeCheckContract);
  /** Fail a cloud left unchecked for want of credentials too. */
  requireClouds?: boolean;
  words?: CiProductWordsInput | CiProductWords;
  /** The config the contract came from, for the result. */
  file?: string;
}

export function countRows(rows: readonly CheckRow[]): Record<CheckStatus, number> {
  const counts = Object.fromEntries(CHECK_STATUSES.map((s) => [s, 0])) as Record<CheckStatus, number>;
  for (const r of rows) counts[r.status]++;
  return counts;
}

/** Run the check. Every request goes through ./read-only.ts; a write is refused before it is sent. */
export async function forgeCheck(input: ForgeCheckInput, deps: ForgeCheckDeps): Promise<ForgeCheckResult> {
  const words = resolveProductWords(input.words);
  const command = forgeCheckCommand(words);
  const fetch = readOnly(deps.fetch, command);
  const t = input.target;
  const repo = await readRepository(fetch, t);
  const live: LiveRepository = repo.ok ? repo.value : {};
  const contract = typeof input.contract === "function" ? input.contract(live) : input.contract;
  const rows: CheckRow[] = [];
  if (!repo.ok) {
    const need = t.kind === "github" ? SCOPES.github : t.kind === "gitlab" ? SCOPES.gitlab : SCOPES.forgejo;
    rows.push({ where: t.kind, check: "repository", subject: contract.repository.path, expected: "readable", found: couldNot(repo, `${need}, in ${t.tokenSource}`), status: "unknown" });
  } else {
    if (t.kind === "github") rows.push(...(await githubRows(fetch, t, contract)));
    else if (t.kind === "gitlab") rows.push(...(await gitlabRows(fetch, t, contract)));
    else rows.push(...(await forgejoRows(fetch, t, contract)));
    rows.push(...(await statusReportedRows(fetch, t, contract)));
  }
  rows.push(...(await awsRows(contract, fetch, deps, words.product)), ...(await gcpRows(contract, fetch, deps)), ...(await azureRows(contract, fetch, deps)), ...(await pulumiRows(contract, fetch, deps)));
  const counts = countRows(rows);
  const unchecked = rows.some((r) => r.status === "not-checked" && (IDENTITY_CLOUDS as readonly string[]).includes(r.where));
  return {
    schema: forgeCheckSchema(words),
    ...(input.file ? { file: input.file } : {}),
    forge: contract.forge,
    repository: contract.repository,
    rows,
    counts,
    ok: counts.mismatch === 0 && !(input.requireClouds && unchecked),
  };
}

/** chant's `failed` on a mismatch, or a cloud left unchecked with `requireClouds`; `done` otherwise. */
export const forgeCheckExit = (r: ForgeCheckResult): number => (r.ok ? CHANT_EXIT.done : CHANT_EXIT.failed);

const MATCH_WORD: Record<CheckStatus, string> = { match: "yes", mismatch: "no", unknown: "unknown", "not-checked": "not checked" };

/** The table the command prints without --json, and a line of counts. */
export function describeForgeCheck(r: ForgeCheckResult): string {
  const head = ["WHERE", "CHECK", "SUBJECT", "EXPECTED", "FOUND", "MATCH"];
  const body = r.rows.map((x) => [x.where, x.check, x.subject, x.expected, x.found, MATCH_WORD[x.status]]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i]!.length)));
  const line = (cells: string[]): string => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]!))).join("  ");
  const c = r.counts;
  const out = [`${r.file ? `${r.file}: ` : ""}${r.forge} ${r.repository.host}/${r.repository.path} (default branch ${r.repository.defaultBranch})`, ""];
  if (body.length) out.push(line(head), ...body.map(line), "");
  else out.push("nothing to check: no forge environment, apply runner, protected branch, required status or cloud identity in the contract", "");
  out.push(`${c.match} match, ${c.mismatch} mismatch, ${c.unknown} could not be read, ${c["not-checked"]} not checked`);
  return out.join("\n");
}

/** The clouds a result left unchecked for want of credentials. */
export const uncheckedClouds = (r: ForgeCheckResult): IdentityCloud[] => IDENTITY_CLOUDS.filter((cloud) => r.rows.some((x) => x.where === cloud && x.status === "not-checked"));

export class ForgeCheckTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForgeCheckTargetError";
  }
}

const hostOf = (url: string | undefined): string | undefined => {
  if (!url) return undefined;
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
};

/**
 * The forge to read, from the environment a person or a job has: the forge
 * (`kind`, else the job's own), the repository (`repo`, else the job's),
 * the REST base and a token in {@link FORGE_TOKEN_ORDER}. Unlike
 * `forgeTargetFromEnv` it needs no pull request and runs on a laptop with
 * `--repo` and a token.
 */
export function forgeCheckTarget(env: Record<string, string | undefined>, opts: { kind?: ForgeKind; repo?: string; tokenEnv?: string } = {}): ForgeTarget {
  const pick = (...names: string[]): string | undefined => names.map((n) => env[n]?.trim()).find((v) => v !== undefined && v !== "");
  const kind: ForgeKind | undefined = opts.kind ?? (env.GITLAB_CI ? "gitlab" : env.FORGEJO_ACTIONS || env.FORGEJO_SERVER_URL ? "forgejo" : env.GITHUB_ACTIONS || env.GITHUB_REPOSITORY ? "github" : undefined);
  if (!kind) throw new ForgeCheckTargetError("cannot tell the forge: pass --forge github|gitlab|forgejo");
  const names = opts.tokenEnv ? [opts.tokenEnv] : FORGE_TOKEN_ORDER[kind];
  const tokenSource = names.find((n) => env[n]?.trim()) ?? names[0]!;
  const token = env[tokenSource]?.trim() ?? "";
  if (kind === "gitlab") {
    const server = pick("CI_SERVER_URL")?.replace(/\/+$/, "") ?? "https://gitlab.com";
    const apiBase = pick("CI_API_V4_URL")?.replace(/\/+$/, "") ?? `${server}/api/v4`;
    const repo = opts.repo ?? pick("CI_PROJECT_PATH", "CI_PROJECT_ID");
    if (!repo) throw new ForgeCheckTargetError("cannot tell the project: pass --repo <group/project>, or run in a GitLab job");
    return { kind, apiBase, repo, host: pick("CI_SERVER_HOST")?.toLowerCase() ?? hostOf(server) ?? "gitlab.com", token, tokenSource, tokenHeader: tokenSource === "CI_JOB_TOKEN" ? "JOB-TOKEN" : "PRIVATE-TOKEN" };
  }
  const fj = kind === "forgejo";
  const read = (name: string): string | undefined => (fj ? pick(`FORGEJO_${name}`, `GITHUB_${name}`) : pick(`GITHUB_${name}`));
  const server = read("SERVER_URL")?.replace(/\/+$/, "");
  const apiBase = read("API_URL")?.replace(/\/+$/, "") ?? (fj ? (server ? `${server}/api/v1` : undefined) : "https://api.github.com");
  if (!apiBase) throw new ForgeCheckTargetError("cannot tell the Forgejo instance: set FORGEJO_SERVER_URL");
  const repo = opts.repo ?? read("REPOSITORY");
  if (!repo) throw new ForgeCheckTargetError("cannot tell the repository: pass --repo <owner/name>, or run in a forge job");
  return { kind, apiBase, repo, host: hostOf(server) ?? (fj ? hostOf(apiBase)! : "github.com"), token, tokenSource };
}
