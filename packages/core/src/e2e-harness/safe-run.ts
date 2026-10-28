/**
 * The harness's one no-real-cloud wrapper (chant#4587), with plunge's rule
 * (scripts/plunge-safe-run.sh, scripts/plunge-races/record.sh:8-11): every
 * process a scenario starts runs with no real cloud credential in reach, its
 * output is logged, and a run whose log shows a real cloud answering is
 * never recorded. A row is written only after a CLEAN scan.
 *
 * What a command runs with: every AWS_*, AZURE_*, ARM_*, GOOGLE_*, CLOUDSDK_*
 * and GCE_* variable unset (GOOGLE_APPLICATION_CREDENTIALS among them), then
 * floci's test credentials, empty AWS config files, an empty CLOUDSDK_CONFIG
 * and AZURE_CONFIG_DIR, a closed loopback GCE metadata host, no
 * PULUMI_ACCESS_TOKEN, and a file:// Pulumi backend in the scratch
 * directory (a backend already set is kept only when it is local).
 *
 * The scan looks for what a real cloud answers to a fake or missing
 * credential, which no emulator says: UnrecognizedClientException,
 * InvalidClientTokenId, invalid_grant, AADSTS, CREDENTIALS_MISSING, and a 401
 * on a line naming googleapis.com, amazonaws.com, azure.com or windows.net.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OpRunRecordInput } from "../op/runtime";
import type { RunOrigin } from "../lifecycle/release-ledger";
import { claimRunRecordInput } from "./claim";
import type { ClaimRun } from "./driver";
import type { OutOfBand } from "./ports";
import type { ClaimRow } from "./schemas/index";

/** The prefixes of every variable a cloud SDK reads credentials or config from. */
export const CLOUD_ENV_PREFIXES = ["AWS_", "AZURE_", "ARM_", "GOOGLE_", "CLOUDSDK_", "GCE_"] as const;

const MARKERS = /UnrecognizedClientException|InvalidClientTokenId|invalid_grant|AADSTS[0-9]*|CREDENTIALS_MISSING/;
const CLOUD_HOSTS = /googleapis\.com|amazonaws\.com|azure\.com|windows\.net/;
const FOUR_OH_ONE = /(^|[^0-9])401([^0-9]|$)/;

/** A backend URL a run may keep: local files, or a bucket store on a loopback emulator. */
export function backendIsLocal(url: string, env: Record<string, string | undefined> = {}): boolean {
  if (url.startsWith("file://") || url.startsWith("plunge+file://")) return true;
  if (url.startsWith("plunge+s3://") || url.startsWith("plunge+azblob://")) {
    return /[?&](endpoint=https?(:\/\/|%3A%2F%2F)(localhost|127\.0\.0\.1)([:/%]|$|&)|metadata_host=(localhost|127\.0\.0\.1)(:|%3A))/.test(url);
  }
  if (url.startsWith("plunge+gs://")) return /^(localhost|127\.0\.0\.1):[0-9]+$/.test(env.STORAGE_EMULATOR_HOST ?? "");
  return false;
}

export interface SafeEnvOptions {
  /** The scratch directory for the empty config locations and the state. */
  scratch: string;
  /** Variables set after the scrub: an emulator endpoint, BREAK=1. GOOGLE_APPLICATION_CREDENTIALS is refused. */
  extra?: Record<string, string>;
}

/** The environment a scenario's processes run with, from `base` (default process.env). */
export function safeRunEnv(o: SafeEnvOptions, base: Record<string, string | undefined> = process.env): Record<string, string> {
  for (const k of Object.keys(o.extra ?? {})) {
    if (k === "GOOGLE_APPLICATION_CREDENTIALS") throw new Error("GOOGLE_APPLICATION_CREDENTIALS is refused: no credentials file may be in reach of a run");
  }
  const backend = base.PULUMI_BACKEND_URL;
  if (backend && !backendIsLocal(backend, base)) {
    throw new Error(`PULUMI_BACKEND_URL=${backend} is not a local backend (file://, plunge+file://, or a plunge store on a loopback emulator)`);
  }
  mkdirSync(o.scratch, { recursive: true });
  const dir = mkdtempSync(join(o.scratch, "env-"));
  for (const d of ["gcloud", "azure", "state"]) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, "aws-config"), "");
  writeFileSync(join(dir, "aws-credentials"), "");

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || k === "PULUMI_ACCESS_TOKEN") continue;
    if (CLOUD_ENV_PREFIXES.some((p) => k.startsWith(p))) continue;
    env[k] = v;
  }
  Object.assign(env, {
    AWS_ACCESS_KEY_ID: "test",
    AWS_SECRET_ACCESS_KEY: "test",
    AWS_REGION: "us-east-1",
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_CONFIG_FILE: join(dir, "aws-config"),
    AWS_SHARED_CREDENTIALS_FILE: join(dir, "aws-credentials"),
    CLOUDSDK_CONFIG: join(dir, "gcloud"),
    AZURE_CONFIG_DIR: join(dir, "azure"),
    GCE_METADATA_HOST: "127.0.0.1:9",
    PULUMI_SKIP_UPDATE_CHECK: "true",
    PULUMI_SKIP_CONFIRMATIONS: "true",
    PULUMI_BACKEND_URL: backend ?? `file://${join(dir, "state")}`,
  });
  Object.assign(env, o.extra ?? {});
  return env;
}

/** The lines of `text` a real cloud wrote, as `<where>:<line>:<text>`. */
export function realCloudHits(text: string, where = "log"): string[] {
  const out: string[] = [];
  text.split("\n").forEach((line, i) => {
    if (MARKERS.test(line) || (FOUR_OH_ONE.test(line) && CLOUD_HOSTS.test(line))) out.push(`${where}:${i + 1}:${line}`);
  });
  return out;
}

export type SafeVerdict = { verdict: "CLEAN" } | { verdict: "REAL-CLOUD"; hits: string[] };

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
}

/**
 * One scenario's wrapper: the scrubbed environment, the log every process's
 * output goes to, and the scan at the end. A directory named in `scan` that
 * does not exist when the scan runs is a hit, since it could not be checked.
 */
export class SafeRun {
  readonly env: Record<string, string>;
  readonly logFile: string;

  constructor(private readonly o: SafeEnvOptions & { logFile?: string; scan?: string[]; echo?: boolean }, base: Record<string, string | undefined> = process.env) {
    this.env = safeRunEnv(o, base);
    this.logFile = o.logFile ?? join(o.scratch, "safe-run.log");
    appendFileSync(this.logFile, `e2e-safe-run: ${new Date().toISOString()} PULUMI_BACKEND_URL=${this.env.PULUMI_BACKEND_URL} CLOUDSDK_CONFIG=${this.env.CLOUDSDK_CONFIG}\n`);
  }

  log(line: string): void {
    appendFileSync(this.logFile, line.endsWith("\n") ? line : `${line}\n`);
  }

  /** Run a command with the scrubbed environment, its output teed to the log. Resolves with its exit code. */
  run(command: string[], extra: Record<string, string> = {}): Promise<number> {
    const [file, ...args] = command;
    if (!file) return Promise.reject(new Error("no command to run"));
    this.log(`e2e-safe-run: command: ${command.map((a) => JSON.stringify(a)).join(" ")}`);
    return new Promise((resolve, reject) => {
      const child = spawn(file, args, { env: { ...this.env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", (b: Buffer) => {
        appendFileSync(this.logFile, b);
        if (this.o.echo) process.stdout.write(b);
      });
      child.stderr.on("data", (b: Buffer) => {
        appendFileSync(this.logFile, b);
        if (this.o.echo) process.stderr.write(b);
      });
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 1));
    });
  }

  /** Out-of-band steps, run through this wrapper. */
  outOfBand(): OutOfBand {
    return { run: (command) => this.run(command) };
  }

  /** The scan of the log and every `scan` directory. Writes the verdict line to the log. */
  scan(extraDirs: string[] = []): SafeVerdict {
    const hits = realCloudHits(readFileSync(this.logFile, "utf8"), this.logFile);
    for (const d of [...(this.o.scan ?? []), ...extraDirs]) {
      if (!existsSync(d)) {
        hits.push(`${d}: the scan directory does not exist after the run, so it could not be checked`);
        continue;
      }
      for (const f of filesUnder(d)) if (f !== this.logFile) hits.push(...realCloudHits(readFileSync(f, "utf8"), f));
    }
    if (hits.length > 0) {
      this.log(`e2e-safe-run: REAL-CLOUD CALL: the output shows a public cloud rejecting a credential, so a call left this machine. This run is not recorded.\n${hits.map((h) => `  ${h}`).join("\n")}`);
      return { verdict: "REAL-CLOUD", hits };
    }
    this.log("e2e-safe-run: CLEAN");
    return { verdict: "CLEAN" };
  }
}

export interface RecordClaimInput {
  row: ClaimRow;
  run: ClaimRun;
  /** The scan of the run. Anything but CLEAN is refused and nothing is written. */
  verdict: SafeVerdict;
  /** Append the run record to the ledger (appendRunRecord, then push chant/lifecycle). */
  append(input: OpRunRecordInput): Promise<void>;
  env?: string;
  gitSha?: string;
  runOrigin?: RunOrigin;
}

/** Record a claim run on the ledger, only after a CLEAN scan. */
export async function recordClaimRow(i: RecordClaimInput): Promise<OpRunRecordInput> {
  if (i.verdict.verdict !== "CLEAN") {
    throw new Error(`refusing to record ${i.row.scenario}/${i.row.claim}: the no-real-cloud scan found ${i.verdict.hits.length} real-cloud line(s)`);
  }
  if (i.row.safeRun !== "CLEAN") throw new Error(`refusing to record ${i.row.scenario}/${i.row.claim}: its row does not say CLEAN`);
  const input = claimRunRecordInput({ row: i.row, run: i.run, env: i.env, gitSha: i.gitSha, runOrigin: i.runOrigin });
  await i.append(input);
  return input;
}
