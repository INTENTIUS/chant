/**
 * The chant runner's secrets file (#4096, epic #4101): the values a job gets
 * from the host, such as cloud credentials and the endpoint, which a forge
 * job would get from the forge's secrets.
 *
 * `chant ci run` and `chant ci serve` read it from `--secrets <file>`, or
 * the file `CHANT_CI_SECRETS` names. It is a dotenv file of `NAME=value`
 * lines, or a JSON object:
 *
 * - a map of name to value, `{ "AWS_SECRET_ACCESS_KEY": "..." }`;
 * - or `{ "secrets": { ... }, "jobs": { "plan": [...], "apply": [...] } }`,
 *   where `jobs` lists, for a job, the names it gets. A job `jobs` doesn't
 *   name gets every secret.
 *
 * The allowlist lives in this file on the host, not in the repository, so a
 * pull request can't widen what its plan gets.
 *
 * The file must belong to the user reading it and give group and others no
 * permission at all, as ssh asks of a private key (`chmod 600`). A file
 * that does is refused before any job runs.
 *
 * Every value in the file, and every value of the job's environment whose
 * name looks secret ({@link SECRET_NAME}), is redacted from what the run
 * writes about itself (../op/redact.ts).
 */

import { readFileSync, statSync } from "node:fs";
import { redactorOf, type Redact } from "../op/redact";
import { RUNNER_KEY_ENV } from "./ci-green";
import type { CiJobName } from "./ci-run";

/** The variable that names the secrets file when `--secrets` is not given. */
export const CI_SECRETS_ENV = "CHANT_CI_SECRETS";

/** A variable whose name matches this is taken as secret, and its value redacted. */
export const SECRET_NAME = /TOKEN|SECRET|KEY|PASSWORD/i;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The jobs a secrets file can give a list of its own: the pull-request jobs, and a pull request environment's (#4330). */
const JOBS: readonly CiJobName[] = ["plan", "apply", "env-up", "env-post", "env-down", "env-sweep"];

/** The secrets file, read. */
export interface CiSecrets {
  /** Where it was read from. */
  file: string;
  /** Every secret, by name. */
  values: Record<string, string>;
  /** For a job the file names, the secrets it gets. A job missing here gets every one. */
  jobs: Partial<Record<CiJobName, string[]>>;
}

export class CiSecretsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CiSecretsError";
  }
}

/**
 * Refuse a secrets file anyone but its owner can read or write, or that
 * belongs to another user, as ssh refuses a loose key. Not checked on
 * Windows, whose files carry no such mode.
 */
export function checkCiSecretsMode(file: string): void {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(file);
  } catch (err) {
    throw new CiSecretsError(`the secrets file ${file} can't be read: ${(err as NodeJS.ErrnoException).code ?? String(err)}`);
  }
  if (!st.isFile()) throw new CiSecretsError(`the secrets file ${file} is not a file`);
  if (process.platform === "win32") return;
  const loose = Number(st.mode) & 0o077;
  if (loose !== 0) {
    const mode = (Number(st.mode) & 0o777).toString(8).padStart(4, "0");
    throw new CiSecretsError(
      `the secrets file ${file} has mode ${mode}, so its group or other users can ${loose & 0o044 ? "read" : "change"} it; a secrets file must be readable only by its owner, as ssh asks of a key: chmod 600 ${file}`,
    );
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && Number(st.uid) !== uid) {
    throw new CiSecretsError(`the secrets file ${file} belongs to uid ${st.uid}, not to this user (uid ${uid}); a secrets file must be its reader's own`);
  }
}

/** A dotenv text's `NAME=value` pairs. Errors name the line, never a value. */
export function parseDotenv(text: string, file: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  let line = 1;
  const fail = (why: string): never => {
    throw new CiSecretsError(`${file}:${line}: ${why}`);
  };
  while (i < text.length) {
    // One line: blank, a comment, or NAME=value.
    const eol = text.indexOf("\n", i);
    const rest = text.slice(i, eol === -1 ? text.length : eol);
    const trimmed = rest.trim();
    if (trimmed === "" || trimmed.startsWith("#")) {
      i = eol === -1 ? text.length : eol + 1;
      line++;
      continue;
    }
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*/.exec(rest);
    if (!m) fail("expected NAME=value");
    const name = m![1]!;
    let j = i + m![0].length;
    const startLine = line;
    let value = "";
    const q = text[j];
    if (q === '"' || q === "'") {
      j++;
      for (;;) {
        if (j >= text.length) {
          line = startLine;
          fail(`the value of ${name} has no closing ${q}`);
        }
        const c = text[j]!;
        if (c === q) break;
        if (c === "\n") line++;
        if (q === '"' && c === "\\" && j + 1 < text.length) {
          const n = text[j + 1]!;
          value += n === "n" ? "\n" : n === "r" ? "\r" : n === "t" ? "\t" : n;
          j += 2;
          continue;
        }
        value += c;
        j++;
      }
      j++;
      const end = text.indexOf("\n", j);
      const after = text.slice(j, end === -1 ? text.length : end).trim();
      if (after !== "" && !after.startsWith("#")) fail(`unexpected text after the quoted value of ${name}`);
      i = end === -1 ? text.length : end + 1;
    } else {
      const end = text.indexOf("\n", j);
      value = text.slice(j, end === -1 ? text.length : end).replace(/\s+#.*$/, "").trim();
      i = end === -1 ? text.length : end + 1;
    }
    if (Object.prototype.hasOwnProperty.call(out, name)) fail(`${name} is set twice`);
    out[name] = value;
    line++;
  }
  return out;
}

function checkName(name: string, file: string): void {
  if (!ENV_NAME.test(name)) throw new CiSecretsError(`${file} names a secret ${JSON.stringify(name)}, which is not a variable name`);
  if (name === RUNNER_KEY_ENV) throw new CiSecretsError(`${file} sets ${RUNNER_KEY_ENV}, and the runner key is never passed to a job; give it to ci run or ci serve with --key or ${RUNNER_KEY_ENV}`);
}

/** The secrets in a file's text: JSON when it starts with `{`, else dotenv. */
export function parseCiSecrets(text: string, file: string): Omit<CiSecrets, "file"> {
  if (!text.trimStart().startsWith("{")) {
    const values = parseDotenv(text, file);
    for (const name of Object.keys(values)) checkName(name, file);
    return { values, jobs: {} };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // The parser's message quotes the text near the error, which may be a secret.
    throw new CiSecretsError(`${file} starts with {, and is not valid JSON`);
  }
  const doc = raw as Record<string, unknown>;
  const structured = doc.secrets !== null && typeof doc.secrets === "object" && !Array.isArray(doc.secrets);
  const map = (structured ? doc.secrets : doc) as Record<string, unknown>;
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(map)) {
    checkName(name, file);
    if (typeof value !== "string") throw new CiSecretsError(`${file}: the secret ${name} must be a string`);
    values[name] = value;
  }
  const jobs: CiSecrets["jobs"] = {};
  if (structured) {
    for (const key of Object.keys(doc)) if (key !== "secrets" && key !== "jobs") throw new CiSecretsError(`${file} has ${JSON.stringify(key)} beside secrets and jobs`);
    const given = doc.jobs ?? {};
    if (given === null || typeof given !== "object" || Array.isArray(given)) throw new CiSecretsError(`${file}: jobs must map ${JOBS.join(", ")} to lists of secret names`);
    for (const [job, names] of Object.entries(given as Record<string, unknown>)) {
      if (!(JOBS as readonly string[]).includes(job)) throw new CiSecretsError(`${file}: jobs names ${JSON.stringify(job)}, and the jobs are ${JOBS.join(", ")}`);
      if (!Array.isArray(names) || names.some((n) => typeof n !== "string")) throw new CiSecretsError(`${file}: jobs.${job} must be a list of secret names`);
      for (const n of names as string[]) if (!Object.prototype.hasOwnProperty.call(values, n)) throw new CiSecretsError(`${file}: jobs.${job} names ${n}, which the file does not set`);
      jobs[job as CiJobName] = [...(names as string[])];
    }
  }
  return { values, jobs };
}

/** Read the secrets file, refusing one others can read. */
export function readCiSecrets(file: string): CiSecrets {
  checkCiSecretsMode(file);
  return { file, ...parseCiSecrets(readFileSync(file, "utf-8"), file) };
}

/** The secrets `job` gets: those `jobs` lists for it, else every one. */
export function ciSecretsFor(secrets: CiSecrets | undefined, job: CiJobName): Record<string, string> {
  if (!secrets) return {};
  const names = secrets.jobs[job] ?? Object.keys(secrets.values);
  return Object.fromEntries(names.map((n) => [n, secrets.values[n]!]));
}

/**
 * The redactor for a job: every value in the secrets file, whether the job
 * gets it or not, and the value of each variable in the job's environment
 * whose name looks secret, such as `GITHUB_TOKEN` or a `--pass-env
 * AWS_SECRET_ACCESS_KEY`. Undefined when there is nothing to redact.
 */
export function ciRedactor(jobEnv: Record<string, string>, secrets?: CiSecrets): Redact | undefined {
  const values = Object.values(secrets?.values ?? {});
  for (const [name, value] of Object.entries(jobEnv)) if (SECRET_NAME.test(name)) values.push(value);
  return redactorOf(values);
}
