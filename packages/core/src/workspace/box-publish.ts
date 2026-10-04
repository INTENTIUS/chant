/**
 * `chant workspace box publish <member> <item> | --records` (#3165, ws-088):
 * the one call a surface such as hud makes to publish a box's work.
 *
 * Publishing is the orchestrator's: studio's kit merges a built work item's
 * branch into the box's checkout, pushes it to the box's `factory.publish`
 * repo through its broker, opens the pull request, and sends the records a
 * person kept uncommitted. The box block names the command that does it,
 * `box.publisher`, so nothing is injected into a surface's environment.
 *
 * chant does none of that work. It reads the publisher from the declaration,
 * applies the identity rule to `--by` (ws-080), runs the publisher from the
 * workspace root with no shell and a JSON request on stdin, reads the last
 * JSON object it prints, and checks the commit it names for the apply record
 * of ws-075: `Chant-Applied-By` naming `--by`, `Chant-Applied-At`,
 * `Chant-Applied-Commit` and a `Chant-Record` for the item, or a
 * `Chant-Record` for each record sent. It prints one document,
 * `box-publish.schema.json`, and never commits, pushes or calls a forge.
 *
 * The publisher's protocol, which `box-publish.schema.json` also states:
 *
 * - stdin: one JSON object, `$defs.request`.
 * - exit 0 and a JSON object on the last line of stdout that holds one:
 *   `$defs.answer`, with `ok: true`.
 * - exit 2: a refusal, nothing was published, stderr says why.
 * - any other exit: a failure, stderr says why and what was done.
 */

import { spawnSync } from "node:child_process";
import { factoryView, type FactoryView } from "./box-factory";
import { readDeclaration, readerVersion, WORKSPACE_ERROR_CODES, WorkspaceReadError } from "./declaration";
import { IDENTITY_CODES, IdentityError, refuseUnidentified } from "./identity";
import { commitDetails, tryGit } from "./intent";
import type { ReasonCode } from "./reason-codes";
import { readChantTrailers } from "./trailers";
import { locateWorkspace } from "./which-chant";
import { scopeSource } from "./write-scope";

/** The version of the document this command prints, and of the request it gives a publisher. */
export const BOX_PUBLISH_CONTRACT_VERSION = 1;

/** `$id` of the JSON Schema for what `box publish` prints, shipped beside this file. */
export const BOX_PUBLISH_SCHEMA_ID = "https://intentius.io/chant/schemas/workspace/box-publish/v1/box-publish.schema.json";

/** How long a publisher may run before chant stops it: a push and a pull request through a broker, with room to spare. */
export const PUBLISH_TIMEOUT_MS = 600_000;

/** Why a publish printed no result. Closed. */
export const BOX_PUBLISH_ERROR_CODES = [
  ...WORKSPACE_ERROR_CODES,
  "write-usage-invalid",
  "publish-member-unknown",
  "publish-none",
  "publish-refused",
  "publish-failed",
  "publish-answer-invalid",
  "publish-unrecorded",
  ...IDENTITY_CODES,
] as const satisfies readonly ReasonCode[];
export type BoxPublishErrorCode = (typeof BOX_PUBLISH_ERROR_CODES)[number];

/** What a publish is asked to do: one built work item, or the records kept uncommitted. */
export type PublishAction = "item" | "records";

/** A record a publisher sent, or would send with dryRun. */
export interface PublishedRecord {
  kind: string;
  id: string;
  path: string;
  title: string | null;
}

/** The pull request a publisher opened, or found already open. */
export interface PublishedPullRequest {
  url: string;
  number: number;
  branch: string;
  base: string;
  /** owner/name of the fork the branch was pushed to, or null when it went to the repo itself. */
  head: string | null;
}

/** What chant writes on the publisher's stdin. */
export interface PublishRequest {
  contract: number;
  action: PublishAction;
  member: string;
  item: string | null;
  by: string | null;
  head: string | null;
  dryRun: boolean;
  workspace: { root: string };
  /** The workspace's factory as status --json prints it, or null when no box declares one. */
  factory: FactoryView | null;
}

/** The publisher's answer, checked and with every field present. */
export interface PublishAnswer {
  commit: string | null;
  records: PublishedRecord[];
  pullRequest: PublishedPullRequest | null;
  pushed: { branch: string; repo: string } | null;
  local: string | null;
}

/** What `box publish` prints. */
export type BoxPublishDocument =
  | ({
      $schema: string;
      contract: number;
      chant: string;
      member: string;
      action: PublishAction;
      item: string | null;
      by: string | null;
      dryRun: boolean;
      /** The publisher as the box block declares it. */
      publisher: string;
      /** The apply record read back from the commit's trailers, for an item; null for records and with dryRun. */
      applied: { by: string; at: string; commit: string } | null;
      /** The publisher's answer as it printed it, x- fields and all. */
      answer: Record<string, unknown>;
    } & PublishAnswer)
  | {
      $schema: string;
      contract: number;
      chant: string;
      member: string | null;
      action: PublishAction | null;
      item: string | null;
      error: { code: BoxPublishErrorCode; message: string };
      /** The publisher's answer when it printed one and something about it was refused. */
      answer?: Record<string, unknown>;
    };

export interface BoxPublishRequest {
  cwd: string;
  member: string;
  /** The work item to publish; absent with `records`. */
  item?: string;
  /** Publish the records kept uncommitted instead of an item (`--records`). */
  records?: boolean;
  /** Who publishes (`--by`); required unless dryRun. */
  by?: string;
  /** A fork to push to, as owner/name (`--head`). */
  head?: string;
  /** Ask the publisher what would be published, and publish nothing (`--dry-run`). */
  dryRun?: boolean;
  /** The agent session (`CHANT_AGENT`). */
  agent?: string;
  /** The environment the publisher runs with; the caller's when absent. */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

class PublishError extends Error {
  constructor(
    readonly code: BoxPublishErrorCode,
    message: string,
    readonly answer?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const COMMIT_ID = /^[0-9a-f]{40,64}$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const MAX_MESSAGE = 2000;
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Split a command into words as a POSIX shell splits plain words: blanks
 * separate words, single quotes keep everything, double quotes keep
 * everything but `\\`, `\"`, `\$` and `` \` ``, and a backslash outside quotes
 * escapes the next character. Nothing else a shell does (variables, `~`,
 * globs, pipes, redirection) happens: those characters are part of a word.
 */
export function splitCommand(text: string): string[] {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && i + 1 < text.length && '\\"$`'.includes(text[i + 1])) word += text[++i];
      else word += c;
      continue;
    }
    if (c === " " || c === "\t" || c === "\n") {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
      continue;
    }
    inWord = true;
    if (c === "'" || c === '"') quote = c;
    else if (c === "\\") {
      if (i + 1 < text.length) word += text[++i];
    } else word += c;
  }
  if (quote !== null) throw new Error(`it has an unclosed ${quote} quote`);
  if (inWord) words.push(word);
  if (words.length === 0) throw new Error("it is empty");
  return words;
}

/** The last line of `stdout` that is a JSON object, or null. */
function lastJsonObject(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const value: unknown = JSON.parse(lines[i]);
      if (isObject(value)) return value;
    } catch {
      // Not this line.
    }
  }
  return null;
}

const clip = (text: string) => {
  const t = text.trim();
  return t.length > MAX_MESSAGE ? `...${t.slice(-MAX_MESSAGE)}` : t;
};

const line = (v: unknown): v is string => typeof v === "string" && v.trim() !== "" && !/[\u0000-\u001f\u007f]/.test(v);

/** The publisher's answer, checked field by field, or a reason it is not one. */
export function readAnswer(answer: Record<string, unknown>): PublishAnswer | string {
  if (answer.ok !== true) return "it has no ok: true";
  const out: PublishAnswer = { commit: null, records: [], pullRequest: null, pushed: null, local: null };
  if (answer.commit !== undefined && answer.commit !== null) {
    if (typeof answer.commit !== "string" || !COMMIT_ID.test(answer.commit)) return `its commit ${JSON.stringify(answer.commit)} is not a full commit id`;
    out.commit = answer.commit;
  }
  if (answer.records !== undefined) {
    if (!Array.isArray(answer.records)) return "its records is not a list";
    for (const [i, r] of answer.records.entries()) {
      if (!isObject(r) || !line(r.kind) || !line(r.id) || !line(r.path)) return `records[${i}] is not { kind, id, path, title }`;
      if (r.title !== undefined && r.title !== null && typeof r.title !== "string") return `records[${i}].title is not a string`;
      out.records.push({ kind: r.kind, id: r.id, path: r.path, title: typeof r.title === "string" ? r.title : null });
    }
  }
  if (answer.pullRequest !== undefined && answer.pullRequest !== null) {
    const pr = answer.pullRequest;
    let https = false;
    try {
      https = isObject(pr) && typeof pr.url === "string" && new URL(pr.url).protocol === "https:";
    } catch {
      https = false;
    }
    if (!isObject(pr) || !https || typeof pr.number !== "number" || !Number.isSafeInteger(pr.number) || pr.number <= 0 || !line(pr.branch) || !line(pr.base)) {
      return "its pullRequest is not { url (https), number, branch, base, head }";
    }
    if (pr.head !== undefined && pr.head !== null && !(typeof pr.head === "string" && REPO.test(pr.head))) return "its pullRequest.head is not owner/name";
    out.pullRequest = { url: pr.url as string, number: pr.number, branch: pr.branch, base: pr.base, head: typeof pr.head === "string" ? pr.head : null };
  }
  if (answer.pushed !== undefined && answer.pushed !== null) {
    const p = answer.pushed;
    if (!isObject(p) || !line(p.branch) || !line(p.repo)) return "its pushed is not { branch, repo }";
    out.pushed = { branch: p.branch, repo: p.repo };
  }
  if (answer.local !== undefined && answer.local !== null) {
    if (typeof answer.local !== "string") return "its local is not a string";
    out.local = answer.local;
  }
  return out;
}

/** Run the publish and build the document it prints. Never throws for a refusal. */
export function boxPublish(req: BoxPublishRequest): BoxPublishDocument {
  const head = { $schema: BOX_PUBLISH_SCHEMA_ID, contract: BOX_PUBLISH_CONTRACT_VERSION, chant: readerVersion() };
  const action: PublishAction = req.records ? "records" : "item";
  try {
    return publish(req, action, head);
  } catch (err) {
    const fail = (code: BoxPublishErrorCode, message: string, answer?: Record<string, unknown>): BoxPublishDocument => ({
      ...head,
      member: req.member || null,
      action,
      item: req.item ?? null,
      error: { code, message },
      ...(answer ? { answer } : {}),
    });
    if (err instanceof PublishError) return fail(err.code, err.message, err.answer);
    if (err instanceof IdentityError) return fail(err.code, err.message);
    if (err instanceof WorkspaceReadError) return fail(err.code as BoxPublishErrorCode, err.describe());
    throw err;
  }
}

function publish(req: BoxPublishRequest, action: PublishAction, head: { $schema: string; contract: number; chant: string }): BoxPublishDocument {
  if (!req.member) throw new PublishError("write-usage-invalid", "box publish needs the member whose box publishes: box publish <member> <item>, or box publish <member> --records");
  if (action === "item") {
    if (req.item === undefined) throw new PublishError("write-usage-invalid", "box publish needs the work item to publish, or --records for the records kept uncommitted");
    if (!RECORD_ID.test(req.item)) throw new PublishError("write-usage-invalid", `${JSON.stringify(req.item)} is not a work item id`);
  } else if (req.item !== undefined) {
    throw new PublishError("write-usage-invalid", `--records publishes the records kept uncommitted and takes no work item, and was given ${req.item}`);
  }
  if (req.head !== undefined && !REPO.test(req.head)) throw new PublishError("write-usage-invalid", `--head names the fork to push to as owner/name, not ${JSON.stringify(req.head)}`);
  const by = req.by?.trim() || null;
  if (by === null && !req.dryRun) throw new PublishError("write-usage-invalid", "box publish needs --by: who publishes, which the apply record names");

  const located = locateWorkspace(req.cwd);
  if (!located.top) throw new WorkspaceReadError("not-a-git-repository", "box publish reads the commit a publisher made, and this directory is not in a git repository");
  const declaration = readDeclaration(located.tree);
  const member = declaration.members.find((m) => m.name === req.member);
  if (!member) {
    throw new PublishError("publish-member-unknown", `no member is named ${req.member}; the declaration's members are ${declaration.members.map((m) => m.name).join(", ") || "none"}`);
  }
  const publisher = member.box?.publisher ?? null;
  if (publisher === null) {
    throw new PublishError(
      "publish-none",
      member.box
        ? `member ${member.name}'s box block names no publisher, so nothing publishes its work; an orchestrator such as studio names one (box.publisher, ws-088)`
        : `member ${member.name} declares no box block, so it has no publisher (box.publisher, ws-088)`,
    );
  }
  let argv: string[];
  try {
    argv = splitCommand(publisher);
  } catch (err) {
    throw new PublishError("publish-failed", `member ${member.name}'s publisher ${JSON.stringify(publisher)} can't be run: ${(err as Error).message}`);
  }
  if (by !== null) refuseUnidentified(scopeSource(req.cwd), [by], "--by", { agent: req.agent });

  const factory = declaration.members.find((m) => m.box?.factory)?.box?.factory ?? null;
  const request: PublishRequest = {
    contract: BOX_PUBLISH_CONTRACT_VERSION,
    action,
    member: member.name,
    item: req.item ?? null,
    by,
    head: req.head ?? null,
    dryRun: req.dryRun === true,
    workspace: { root: located.rootOnDisk },
    factory: factoryView(factory),
  };
  const timeoutMs = req.timeoutMs ?? PUBLISH_TIMEOUT_MS;
  const run = spawnSync(argv[0], argv.slice(1), {
    cwd: located.rootOnDisk,
    input: `${JSON.stringify(request)}\n`,
    env: { ...(req.env ?? process.env), CHANT_PUBLISH_CONTRACT: String(BOX_PUBLISH_CONTRACT_VERSION) },
    encoding: "utf-8",
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  const stdout = run.stdout ?? "";
  const stderr = run.stderr ?? "";
  const printed = lastJsonObject(stdout);
  if (run.error) {
    const e = run.error as NodeJS.ErrnoException;
    if (e.code === "ETIMEDOUT") throw new PublishError("publish-failed", `the publisher gave no answer within ${timeoutMs}ms and was stopped; what it had done by then stays done`, printed ?? undefined);
    throw new PublishError("publish-failed", e.code === "ENOENT" ? `the publisher ${argv[0]} was not found` : `the publisher could not be run: ${e.message}`);
  }
  if (run.status !== 0) {
    const said = clip(stderr) || `it exited ${run.status ?? `on ${run.signal}`} and said nothing on stderr`;
    if (run.status === 2) throw new PublishError("publish-refused", said, printed ?? undefined);
    throw new PublishError("publish-failed", said, printed ?? undefined);
  }
  if (printed === null) throw new PublishError("publish-answer-invalid", "the publisher exited 0 and printed no JSON object on stdout");
  const answer = readAnswer(printed);
  if (typeof answer === "string") throw new PublishError("publish-answer-invalid", `the publisher's answer is not one box-publish.schema.json allows: ${answer}`, printed);

  let applied: { by: string; at: string; commit: string } | null = null;
  if (!req.dryRun) {
    if (answer.commit === null) throw new PublishError("publish-unrecorded", `the publisher answered with no commit, so the ${action === "item" ? "apply" : "records"} commit can't be checked for its trailers`, printed);
    if (action === "records" && answer.records.length === 0) throw new PublishError("publish-answer-invalid", "the publisher sent records and named none", printed);
    applied = checkRecord(located.top, answer, action, req.item ?? null, by!, printed);
  }

  return {
    ...head,
    member: member.name,
    action,
    item: req.item ?? null,
    by,
    dryRun: req.dryRun === true,
    publisher,
    ...answer,
    applied,
    answer: printed,
  };
}

/**
 * The apply record on the commit the publisher named (ws-075): for an item,
 * Chant-Applied-By naming `by`, Chant-Applied-At, Chant-Applied-Commit and a
 * Chant-Record for the item; for records, a Chant-Record for each one sent.
 */
function checkRecord(top: string, answer: PublishAnswer, action: PublishAction, item: string | null, by: string, printed: Record<string, unknown>): { by: string; at: string; commit: string } | null {
  const sha = answer.commit!;
  if (tryGit(top, ["cat-file", "-e", `${sha}^{commit}`]) === undefined) {
    throw new PublishError("publish-unrecorded", `the publisher named commit ${sha}, which this repository does not have`, printed);
  }
  const commit = commitDetails(top, [sha]).get(sha);
  const trailers = readChantTrailers(commit?.trailers ?? {});
  const missing: string[] = [];
  if (action === "records") {
    for (const r of answer.records) if (!trailers.records.some((t) => t.kind === r.kind && t.id === r.id)) missing.push(`Chant-Record: ${r.kind}:${r.id}`);
    if (missing.length) throw new PublishError("publish-unrecorded", `commit ${sha.slice(0, 12)} sends records without naming them: it lacks ${missing.join(", ")} (ws-075)`, printed);
    return null;
  }
  if (!trailers.records.some((t) => t.id === item)) missing.push(`Chant-Record: <kind>:${item}`);
  if (trailers.applied === null) missing.push(`Chant-Applied-By: ${by}`);
  else if (trailers.applied.by !== by) missing.push(`Chant-Applied-By: ${by} (it names ${trailers.applied.by})`);
  if (trailers.applied?.at === null || trailers.applied?.at === undefined || Number.isNaN(Date.parse(trailers.applied.at))) missing.push("Chant-Applied-At: <ISO 8601>");
  if (trailers.applied?.commit === null || trailers.applied?.commit === undefined) missing.push("Chant-Applied-Commit: <the applied branch's tip>");
  if (missing.length) throw new PublishError("publish-unrecorded", `commit ${sha.slice(0, 12)} applies ${item} without its apply record: it lacks ${missing.join(", ")} (ws-075)`, printed);
  return { by: trailers.applied!.by, at: trailers.applied!.at!, commit: trailers.applied!.commit! };
}
