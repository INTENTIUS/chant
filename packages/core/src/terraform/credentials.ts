/**
 * The token Terraform and OpenTofu send to a host (chant#4563), found the way
 * the CLIs find it:
 *
 * 1. `TF_TOKEN_<host>`: the host in its comparison form (lower case, punycode
 *    for an internationalised name, port 443 dropped), dots written `_` and
 *    dashes `__`. A variable whose name decodes to the host matches too, so
 *    `TF_TOKEN_App_Terraform_Io` is read for app.terraform.io, as the CLIs
 *    read it. A host with another port has no variable form.
 * 2. A `credentials "<host>" { token = "..." }` block in the CLI config file
 *    `TF_CLI_CONFIG_FILE` names (HCL, or the same shape in JSON).
 * 3. `credentials.tfrc.json` at the CLI's default path:
 *    `$HOME/.terraform.d/credentials.tfrc.json`, or
 *    `%APPDATA%\terraform.d\credentials.tfrc.json` on Windows.
 *
 * The variable wins over both files. Credential helpers are not run.
 *
 * This sits in core, not in the terraform lexicon, because core's own import
 * code (`workspace init --from tfc`) reads the same token and core does not
 * depend on the lexicon. The lexicon's registry reader imports it from here.
 *
 * A token found here is only ever put in an `Authorization` header. The
 * `from` this module reports names the variable or the file, never the value.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Where the lookup reads: the environment, and how a file is read (a test passes a map). */
export interface CredentialsOptions {
  /** Default `process.env`. `HOME` (or `APPDATA` on Windows) in it locates the default credentials file; without it that file is skipped. */
  env?: Record<string, string | undefined>;
  /** Reads a file's text, or undefined when it is missing. Default: the file system. */
  readFile?: (path: string) => string | undefined;
  /** Default `process.platform`. */
  platform?: string;
}

/** A token and where it was found: a variable's name or a file's path. */
export interface TerraformCredential {
  token: string;
  from: string;
}

/**
 * The host in the form the CLIs compare credentials by: lower case, an
 * internationalised name in punycode, and the default port 443 dropped.
 * Undefined when the text is not a host.
 */
export function credentialsHost(host: string): string | undefined {
  const raw = host.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split("/")[0]!;
  if (!raw) return undefined;
  try {
    const u = new URL(`https://${raw}`);
    if (u.username || u.password) return undefined;
    return u.port && u.port !== "443" ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return undefined;
  }
}

/**
 * The variable a host's token is read from: `TF_TOKEN_` and the host with
 * dashes written `__` and dots `_`. Undefined for a host with a port other
 * than 443, which only the credentials file can name.
 */
export function tokenVariable(host: string): string | undefined {
  const h = credentialsHost(host);
  if (!h || h.includes(":")) return undefined;
  return `TF_TOKEN_${h.replace(/-/g, "__").replace(/\./g, "_")}`;
}

/** The host a `TF_TOKEN_` variable's name stands for, in comparison form. */
const hostOfVariable = (name: string): string | undefined => {
  const rest = name.slice("TF_TOKEN_".length);
  if (!rest) return undefined;
  return credentialsHost(rest.replace(/__/g, "\u0000").replace(/_/g, ".").replace(/\u0000/g, "-"));
};

const defaultReadFile = (path: string): string | undefined => {
  try {
    return existsSync(path) ? readFileSync(path, "utf-8") : undefined;
  } catch {
    return undefined;
  }
};

/** The default credentials.tfrc.json path, or undefined when the environment names no home. */
export function credentialsFilePath(options: CredentialsOptions = {}): string | undefined {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return env.APPDATA ? join(env.APPDATA, "terraform.d", "credentials.tfrc.json") : undefined;
  return env.HOME ? join(env.HOME, ".terraform.d", "credentials.tfrc.json") : undefined;
}

/** The token a credentials map gives a host, matching keys in comparison form. */
const tokenIn = (credentials: unknown, host: string): string | undefined => {
  if (!credentials || typeof credentials !== "object") return undefined;
  for (const [key, value] of Object.entries(credentials as Record<string, unknown>)) {
    // A JSON CLI config may hold each block as a one-element list.
    const block = Array.isArray(value) ? value[0] : value;
    if (credentialsHost(key) !== host || !block || typeof block !== "object") continue;
    const token = (block as { token?: unknown }).token;
    if (typeof token === "string" && token) return token;
  }
  return undefined;
};

/** `credentials "<host>" { token = "..." }` blocks in an HCL CLI config, by host. */
const hclCredentials = (text: string): Record<string, { token: string }> => {
  const out: Record<string, { token: string }> = {};
  const noComments = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*(#|\/\/).*$/gm, "");
  const block = /credentials\s+"([^"]+)"\s*\{([^}]*)\}/g;
  for (let m = block.exec(noComments); m; m = block.exec(noComments)) {
    const token = /(?:^|[\s;])token\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(m[2]!)?.[1];
    if (token) out[m[1]!] = { token: token.replace(/\\(.)/g, "$1") };
  }
  return out;
};

/** The credentials a CLI config file's text holds, read as JSON when it parses and as HCL otherwise. */
const fileCredentials = (text: string): unknown => {
  try {
    return (JSON.parse(text) as { credentials?: unknown }).credentials;
  } catch {
    return hclCredentials(text);
  }
};

/** The token for a host and where it came from, or undefined when the CLIs would send none. */
export function terraformCredential(host: string, options: CredentialsOptions = {}): TerraformCredential | undefined {
  const h = credentialsHost(host);
  if (!h) return undefined;
  const env = options.env ?? process.env;
  const readFile = options.readFile ?? defaultReadFile;

  const exact = tokenVariable(h);
  if (exact && env[exact]) return { token: env[exact]!, from: exact };
  if (!h.includes(":")) {
    for (const [name, value] of Object.entries(env)) {
      if (value && name.startsWith("TF_TOKEN_") && hostOfVariable(name) === h) return { token: value, from: name };
    }
  }

  const files = [env.TF_CLI_CONFIG_FILE, credentialsFilePath({ ...options, env })].filter((p): p is string => !!p);
  for (const path of files) {
    const text = readFile(path);
    if (text === undefined) continue;
    const token = tokenIn(fileCredentials(text), h);
    if (token) return { token, from: path };
  }
  return undefined;
}

/** The token for a host, or undefined. */
export const terraformToken = (host: string, options: CredentialsOptions = {}): string | undefined => terraformCredential(host, options)?.token;

/** `{ Authorization: "Bearer <token>" }` for a host with a token, else `{}`. */
export function authorizationFor(host: string, options: CredentialsOptions = {}): Record<string, string> {
  const token = terraformToken(host, options);
  return token ? { Authorization: `Bearer ${token}` } : {};
}
