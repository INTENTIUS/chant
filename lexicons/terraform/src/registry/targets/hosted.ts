/**
 * What the Artifactory and Nexus module targets share (chant#4605): basic
 * `user:token` write credentials (terragucci#1299 ruling B), a binary GET of
 * an uploaded archive, and the wait for a version to be listed after its
 * upload, since both hosts index an upload after the PUT answers.
 */
import { readCredential, type Credential } from "@intentius/chant/lifecycle/publish-credentials";
import { PublishTargetError, type PublishContextBase } from "@intentius/chant/lifecycle/release-publish";
import type { RegistryFetch } from "../reader";
import { answerError, contentDigest } from "./module-target";
import { heldContentOf } from "./zip";

/** Where a target reads its basic credentials. */
export interface BasicCredentialEnv {
  /** The variable the token (or password) is read from. */
  tokenEnv: string;
  /** The variable the user name is read from, when `user` is not given. */
  userEnv: string;
  /** The user name itself, in place of `userEnv`. */
  user?: string;
}

/** A user and token, and the `Authorization` header they make. The header and the token are masked. */
export interface BasicCredential {
  user: string;
  token: Credential;
  /** `Basic <base64 of user:token>`. */
  header: string;
}

/** The basic credential the environment holds, added to the redactor, or null when either half is missing. */
export function readBasicCredential(ctx: Pick<PublishContextBase, "env" | "redactor">, names: BasicCredentialEnv): BasicCredential | null {
  const token = readCredential(ctx.env, [names.tokenEnv], ctx.redactor);
  const user = names.user ?? ctx.env[names.userEnv];
  if (!token || !user) return null;
  const encoded = Buffer.from(`${user}:${token.value}`, "utf-8").toString("base64");
  ctx.redactor.add(encoded);
  return { user, token, header: `Basic ${encoded}` };
}

/** The basic credential, or the refusal naming both variables. */
export function needBasicCredential(ctx: Pick<PublishContextBase, "env" | "redactor">, names: BasicCredentialEnv, host: string, fix: string): BasicCredential {
  const c = readBasicCredential(ctx, names);
  if (c) return c;
  const missing = [...(ctx.env[names.tokenEnv] ? [] : [names.tokenEnv]), ...(names.user || ctx.env[names.userEnv] ? [] : [names.userEnv])];
  throw answerError(ctx, "publish-credentials-missing", `no ${host} credentials: set ${missing.join(" and ")}`, fix);
}

/** The global fetch, in the reader's shape. */
export const defaultRegistryFetch: RegistryFetch = (url, init) => fetch(url, init);

/** A GET of bytes, with its status. A network failure is a `publish-read-failed`. */
export async function getBytes(
  ctx: Pick<PublishContextBase, "redactor">,
  fetchFn: RegistryFetch,
  url: string,
  authorization?: string,
): Promise<{ status: number; bytes: Uint8Array }> {
  let res: Response;
  try {
    res = await fetchFn(url, { method: "GET", redirect: "follow", ...(authorization ? { headers: { Authorization: authorization } } : {}) });
  } catch (e) {
    throw answerError(ctx, "publish-read-failed", `GET ${url}: ${(e as Error).message}`);
  }
  return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()) };
}

/** How long a reveal waits for the host to list an uploaded version, and how often it asks. */
export interface ListWait {
  waitMs: number;
  pollMs: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export const HOSTED_LIST_WAIT_MS = 30_000;
export const HOSTED_POLL_MS = 2_000;

/** Reads `list` until it holds `version` or the wait is over; true when it was listed. */
export async function waitListed(list: () => Promise<string[]>, version: string, wait: ListWait): Promise<boolean> {
  const start = wait.now();
  for (;;) {
    if ((await list()).includes(version)) return true;
    if (wait.now() - start >= wait.waitMs) return false;
    await wait.sleep(wait.pollMs);
  }
}

/** The refusal for a 401 or 403 on an upload, naming the variables, never their values. */
export function writeRefused(ctx: Pick<PublishContextBase, "redactor">, host: string, status: number, what: string, credential: BasicCredential, names: BasicCredentialEnv, fix: string): PublishTargetError {
  const userFrom = names.user ? "the declaration's user" : names.userEnv;
  return answerError(ctx, "publish-credentials-refused", `${host} answered ${status} to the upload of ${what}: it refused the user in ${userFrom} with the token in ${credential.token.from}`, fix);
}

/**
 * The content of the archive a download location holds, as the CLIs would
 * fetch it: the registry's credential goes along only to the registry's own
 * host and only when the location has no query (a signed URL carries its own
 * grant). Refuses a location that answers other than 2xx.
 */
export async function locationContent(
  ctx: Pick<PublishContextBase, "redactor">,
  fetchFn: RegistryFetch,
  location: string,
  registryHost: string,
  authorization: string | undefined,
): Promise<{ content: string; revision?: string }> {
  const u = new URL(location);
  const auth = !u.search && u.host.toLowerCase() === registryHost.toLowerCase() ? authorization : undefined;
  const { status, bytes } = await getBytes(ctx, fetchFn, location, auth);
  if (status < 200 || status > 299) throw answerError(ctx, "publish-read-failed", `${location.split("?")[0]} answered ${status} to the download a consumer would make`);
  return heldContentOf(bytes, contentDigest);
}

/** The refusal for a download that holds other content than the version staged. */
export const revealMismatch = (ctx: Pick<PublishContextBase, "redactor">, where: string, version: string, got: string, want: string): PublishTargetError =>
  answerError(ctx, "publish-reveal-mismatch", `${where} ${version} downloads as ${got}, and this publish staged ${want}`, "Check which archive the repository holds for the version; a published version never changes.");
