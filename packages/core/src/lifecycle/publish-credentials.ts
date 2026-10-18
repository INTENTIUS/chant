/**
 * Credentials for publish targets (#4047), and the redactor every line a
 * publish prints goes through.
 *
 * A target reads its credential from the environment of the run, by a name
 * the declaration gives or the target's default, so a workstation sets it in
 * its shell and CI in the job's secrets. chant never writes a credential to
 * `chant/lifecycle`, to a file it keeps, or to its output: the value is held
 * in memory for the requests that need it, and every line a target prints,
 * and every error it throws, passes through {@link Redactor.redact} first.
 *
 * The redactor masks the value of each credential a target read, the values
 * of the environment variables CI and registries use for tokens
 * ({@link TOKEN_ENV_VARS}), and the token forms npm and HTTP headers write
 * (`_authToken=...`, `Authorization: Bearer ...`).
 */

/** Environment variables that hold a token in CI or for a registry. Their values are masked in all publish output. */
export const TOKEN_ENV_VARS = [
  "NODE_AUTH_TOKEN",
  "NPM_TOKEN",
  "NPM_ID_TOKEN",
  "SIGSTORE_ID_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_RUNTIME_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITLAB_TOKEN",
  "CI_JOB_TOKEN",
  "FORGEJO_TOKEN",
  "GITEA_TOKEN",
  "OCI_PASSWORD",
  "DOCKER_PASSWORD",
] as const;

/** What a masked value is replaced with. */
export const REDACTED = "[redacted]";

/** Masks credentials in text a publish prints. */
export interface Redactor {
  /** Add a value to mask. Values shorter than 4 characters are not masked, since they would mask ordinary text. */
  add(value: string | undefined | null): void;
  redact(text: string): string;
}

/** A redactor that masks the token variables of `env` and every value added to it later. */
export function createRedactor(env: NodeJS.ProcessEnv = {}, names: readonly string[] = []): Redactor {
  const values = new Set<string>();
  const add = (v: string | undefined | null) => {
    if (typeof v === "string" && v.trim().length >= 4) values.add(v.trim());
  };
  for (const name of [...TOKEN_ENV_VARS, ...names]) add(env[name]);
  return {
    add,
    redact(text: string): string {
      let out = text;
      // Longest first, so a value that contains another is masked whole.
      for (const v of [...values].sort((a, b) => b.length - a.length)) out = out.split(v).join(REDACTED);
      return out
        .replace(/(_authToken\s*=\s*)("?)[^\s"]+\2/g, `$1${REDACTED}`)
        .replace(/(authorization:\s*(?:bearer|basic|token)\s+)[^\s"',]+/gi, `$1${REDACTED}`)
        .replace(/(private-token:\s*|job-token:\s*)[^\s"',]+/gi, `$1${REDACTED}`);
    },
  };
}

/** A credential a target read, and the variable it came from. The value is never printed. */
export interface Credential {
  value: string;
  /** The environment variable, or `docker config` for one read from the docker config file. */
  from: string;
}

/** The first of `names` set in `env`, added to `redactor`, or null. */
export function readCredential(env: NodeJS.ProcessEnv, names: readonly string[], redactor: Redactor): Credential | null {
  for (const name of names) {
    const value = env[name];
    if (typeof value === "string" && value !== "") {
      redactor.add(value);
      return { value, from: name };
    }
  }
  return null;
}
