/**
 * `pr-plan --report-url` and `pr-apply --report-url` (#4007): copy a stage's
 * report, its change set and its run events where a reader outside CI can
 * fetch them, keyed by pull request and commit.
 *
 * ```
 * <url>/<pr>/<commit>/pr-<stage>.json
 * <url>/<pr>/<commit>/change-set.json
 * <url>/<pr>/<commit>/pr-<stage>.events.jsonl   (with --events-json)
 * ```
 *
 * `<pr>` is the pull or merge request number, or `unknown` when pr-apply
 * found none, and `<commit>` is the full sha the stage ran on: the pull
 * request's head for pr-plan, the pushed commit for pr-apply. A workspace
 * member's loop (`--member`) adds `/<member>` after the commit. There is no
 * index: a reader that knows the pull request and the commit knows the key.
 * The events file is named for its stage because pr-plan and pr-apply run on
 * the same commit when a pull request merges by fast-forward.
 *
 * The events file is uploaded again, whole, each time a wave, a component or
 * the run settles, so a reader polling the URL sees each wave as it applies.
 * One upload of it is in flight at a time: a settle while one is in flight
 * asks for one more after it, with everything written by then. A failed
 * upload is a warning and the run goes on. The last upload, after the run
 * settles, carries the whole stream, and the report and the change set go
 * with it.
 *
 * Two schemes. `file://<dir>` writes under a directory, each file through a
 * temporary name and a rename, so a reader never sees half a file. `s3://
 * <bucket>/<prefix>` runs the AWS CLI (`aws s3 cp - <s3 url>`, the body on
 * its stdin), which reads its credentials, region and endpoint from the
 * environment the job gives it, the way the aws lexicon's `s3-sync` does.
 * chant passes it no credential and prints none: a failed upload prints the
 * CLI's own error line.
 *
 * Two more (#4554): `gs://<bucket>/<prefix>` and `az://<account>/<container>/
 * <prefix>` go through chant core's object-store clients (./object-store),
 * which read the job's credentials from its environment the way terragucci's
 * report uploads do: GOOGLE_APPLICATION_CREDENTIALS (or a traded
 * GOOGLE_OAUTH_ACCESS_TOKEN) for GCS, and AZURE_STORAGE_KEY or the ARM_
 * OIDC variables for Azure Blob Storage. An older chant refuses either
 * scheme, so a declaration whose `ci.reportUrl` uses one needs
 * {@link REPORT_URL_CLOUDS_FLOOR} as its `minReader`.
 */

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ObjectStore } from "./object-store/common";

/** The first chant that reads a `gs://` or `az://` report URL (#4554). */
export const REPORT_URL_CLOUDS_FLOOR = "0.124.55";

/** Where `--report-url` points. */
export type ReportTarget =
  | { scheme: "file"; url: string; dir: string }
  | { scheme: "s3"; url: string; bucket: string; prefix: string }
  | { scheme: "gs"; url: string; bucket: string; prefix: string }
  | { scheme: "az"; url: string; account: string; container: string; prefix: string };

/** `--report-url` read, or why it can't be. `name` is what the error calls the value: the flag, or `ci.reportUrl` (#4160). */
export function parseReportUrl(raw: string, name = "--report-url"): ReportTarget | { error: string } {
  const url = raw.trim();
  if (url.startsWith("file://")) {
    let dir: string;
    try {
      dir = fileURLToPath(url);
    } catch (err) {
      return { error: `${name} ${url}: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!isAbsolute(dir)) return { error: `${name} ${url}: a file URL names an absolute directory` };
    return { scheme: "file", url: url.replace(/\/+$/, ""), dir };
  }
  const s3 = /^s3:\/\/([^/]+)\/?(.*)$/.exec(url);
  if (s3) {
    const prefix = s3[2]!.replace(/\/+$/, "");
    return { scheme: "s3", url: `s3://${s3[1]}${prefix ? `/${prefix}` : ""}`, bucket: s3[1]!, prefix };
  }
  // #4554: a GCS bucket and an Azure container, named as terragucci's reports.bucket names them.
  const gs = /^gs:\/\/([a-z0-9][a-z0-9._-]{1,221}[a-z0-9])(?:\/(.*))?$/.exec(url);
  if (gs) {
    const prefix = (gs[2] ?? "").replace(/\/+$/, "");
    return { scheme: "gs", url: `gs://${gs[1]}${prefix ? `/${prefix}` : ""}`, bucket: gs[1]!, prefix };
  }
  const az = /^az:\/\/([a-z0-9]{3,24})\/([a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){2,62})(?:\/(.*))?$/.exec(url);
  if (az) {
    const prefix = (az[3] ?? "").replace(/\/+$/, "");
    return { scheme: "az", url: `az://${az[1]}/${az[2]}${prefix ? `/${prefix}` : ""}`, account: az[1]!, container: az[2]!, prefix };
  }
  return { error: `${name} ${url}: takes an s3://<bucket>/<prefix>, gs://<bucket>/<prefix>, az://<account>/<container>/<prefix> or file://<directory> URL` };
}

/** The key a stage's files are kept under, below the URL: `<pr>/<commit>[/<member>]`. */
export function reportKey(pr: number | null, commit: string, member?: string): string {
  return [pr === null ? "unknown" : String(pr), commit, ...(member ? [member] : [])].join("/");
}

/** The events file of a stage. */
export const reportEventsFile = (stage: "plan" | "apply" | "record"): string => `pr-${stage}.events.jsonl`;

/** Puts one object: `key` below the URL. Rejects with a line a person can read. */
export type ReportPut = (key: string, body: string, contentType: string) => Promise<void>;

/** Runs the AWS CLI with `args` and `stdin`, rejecting with its error line on a non-zero exit. */
export type AwsCli = (args: string[], stdin: string) => Promise<void>;

const AWS_BINARY = "aws";

/** The AWS CLI on PATH. */
export const realAwsCli: AwsCli = (args, stdin) =>
  new Promise((resolvePut, reject) => {
    const child = spawn(AWS_BINARY, args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString("utf8");
    });
    child.on("error", (err: NodeJS.ErrnoException) =>
      reject(new Error(err.code === "ENOENT" ? "the AWS CLI (aws) is not on PATH; an s3 report URL is uploaded with it" : err.message)),
    );
    child.on("close", (code) => {
      if (code === 0) return resolvePut();
      const line = stderr.trim().split("\n").filter(Boolean).at(-1) ?? "";
      reject(new Error(`aws s3 cp exited ${code}${line ? `: ${line.slice(0, 300)}` : ""}`));
    });
    child.stdin.on("error", () => {
      // The CLI exited before reading its input; its exit says why.
    });
    child.stdin.end(stdin);
  });

/**
 * The object-store client for a `gs://` or `az://` target (#4554), made once
 * on first use from the job's environment. `store` replaces it in a test.
 */
export type ReportStore = () => Promise<ObjectStore>;

function cloudStore(target: Extract<ReportTarget, { scheme: "gs" | "az" }>, env: NodeJS.ProcessEnv = process.env): ReportStore {
  let made: Promise<ObjectStore> | undefined;
  return () =>
    (made ??= import("./object-store/index").then((m) =>
      target.scheme === "gs"
        ? new m.GcsClient(m.gcsFromEnv({ bucket: target.bucket, setting: "the report URL" }, env))
        : new m.AzureBlobClient(m.azureFromEnv({ account: target.account, container: target.container, setting: "the report URL" }, env)),
    ));
}

/** A key below a cloud target's prefix. */
const cloudKey = (target: { prefix: string }, key: string): string => `${target.prefix ? `${target.prefix}/` : ""}${key}`;

/** A put for `target`. `aws` replaces the AWS CLI in a test, and `store` a GCS or Azure client. */
export function reportPut(target: ReportTarget, aws: AwsCli = realAwsCli, store?: ReportStore): ReportPut {
  if (target.scheme === "gs" || target.scheme === "az") {
    const open = store ?? cloudStore(target);
    return async (key, body, contentType) => {
      await (await open()).put(cloudKey(target, key), body, contentType);
    };
  }
  if (target.scheme === "file") {
    return async (key, body) => {
      const path = join(target.dir, ...key.split("/"));
      mkdirSync(dirname(path), { recursive: true });
      const temp = `${path}.${process.pid}.tmp`;
      writeFileSync(temp, body);
      renameSync(temp, path);
    };
  }
  return (key, body, contentType) => {
    const object = `s3://${target.bucket}/${target.prefix ? `${target.prefix}/` : ""}${key}`;
    return aws(["s3", "cp", "-", object, "--content-type", contentType, "--only-show-errors"], body);
  };
}

/** Reads one object: `key` below the URL. Resolves null for an object that is not there, and rejects with a line a person can read for any other failure. */
export type ReportGet = (key: string) => Promise<string | null>;

/** Runs the AWS CLI with `args` and resolves its stdout, rejecting with its error line on a non-zero exit. */
export type AwsRead = (args: string[]) => Promise<string>;

/** The AWS CLI on PATH, read for the body `aws s3 cp <s3 url> -` prints. */
export const realAwsRead: AwsRead = (args) =>
  new Promise((resolveRead, reject) => {
    const child = spawn(AWS_BINARY, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString("utf8");
    });
    child.on("error", (err: NodeJS.ErrnoException) =>
      reject(new Error(err.code === "ENOENT" ? "the AWS CLI (aws) is not on PATH; an s3 report URL is read with it" : err.message)),
    );
    child.on("close", (code) => {
      if (code === 0) return resolveRead(Buffer.concat(out).toString("utf8"));
      const line = stderr.trim().split("\n").filter(Boolean).at(-1) ?? "";
      reject(new Error(`aws s3 cp exited ${code}${line ? `: ${line.slice(0, 300)}` : ""}`));
    });
  });

/** What the AWS CLI says about an object that does not exist. */
const S3_ABSENT = /\(404\)|Not Found|NoSuchKey|does not exist/i;

/** A get for `target`. `aws` replaces the AWS CLI in a test, and `store` a GCS or Azure client. */
export function reportGet(target: ReportTarget, aws: AwsRead = realAwsRead, store?: ReportStore): ReportGet {
  if (target.scheme === "gs" || target.scheme === "az") {
    const open = store ?? cloudStore(target);
    return async (key) => (await (await open()).get(cloudKey(target, key))) ?? null;
  }
  if (target.scheme === "file") {
    return async (key) => {
      try {
        return readFileSync(join(target.dir, ...key.split("/")), "utf-8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    };
  }
  return async (key) => {
    const object = `s3://${target.bucket}/${target.prefix ? `${target.prefix}/` : ""}${key}`;
    try {
      return await aws(["s3", "cp", object, "-", "--only-show-errors"]);
    } catch (err) {
      if (S3_ABSENT.test(messageOf(err))) return null;
      throw err;
    }
  };
}

/** A stage's upload: its events as they are written, and its files at the end. */
export interface PrReportUpload {
  /** The folder the stage's files go to: `<url>/<key>`. */
  readonly where: string;
  /** One line of the stage's run-event stream. A wave, component or run settle uploads the events. */
  line(line: string): void;
  /** A file to upload when the stage closes, replacing one of the same name. */
  file(name: string, body: string): void;
  /** Wait for the upload in flight, then upload the whole stream and the files. Never throws. */
  close(): Promise<void>;
}

const UPLOAD_ON = new Set(["wave-settle", "component-settle", "run-settle"]);
const NDJSON = "application/x-ndjson";
const JSON_TYPE = "application/json";

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Open a stage's upload to `target` under `key`. `warn` prints a warning line. */
export function openPrReportUpload(input: {
  target: ReportTarget;
  key: string;
  stage: "plan" | "apply" | "record";
  warn: (message: string) => void;
  put?: ReportPut;
}): PrReportUpload {
  const put = input.put ?? reportPut(input.target);
  const where = `${input.target.url}/${input.key}`;
  const eventsKey = `${input.key}/${reportEventsFile(input.stage)}`;
  const files = new Map<string, string>();
  let events = "";
  let inFlight: Promise<void> | undefined;
  let again = false;
  let warned = false;

  const pushEvents = (): void => {
    if (inFlight) {
      again = true;
      return;
    }
    inFlight = put(eventsKey, events, NDJSON)
      .catch((err) => {
        if (warned) return;
        warned = true;
        input.warn(`could not upload the run's events to ${where} as the run went: ${messageOf(err)}. The run goes on, and its end tries again.`);
      })
      .finally(() => {
        inFlight = undefined;
        if (again) {
          again = false;
          pushEvents();
        }
      });
  };

  return {
    where,
    line(line) {
      events += line;
      let type: unknown;
      try {
        type = (JSON.parse(line) as { type?: unknown }).type;
      } catch {
        return;
      }
      if (typeof type === "string" && UPLOAD_ON.has(type)) pushEvents();
    },
    file(name, body) {
      files.set(name, body);
    },
    async close() {
      again = false;
      while (inFlight) await inFlight;
      const uploads: Array<[string, string, string]> = [
        ...(events ? [[eventsKey, events, NDJSON] as [string, string, string]] : []),
        ...[...files].map(([name, body]): [string, string, string] => [`${input.key}/${name}`, body, JSON_TYPE]),
      ];
      for (const [key, body, type] of uploads) {
        try {
          await put(key, body, type);
        } catch (err) {
          input.warn(`could not upload ${key.slice(input.key.length + 1)} to ${where}: ${messageOf(err)}`);
        }
      }
    },
  };
}
