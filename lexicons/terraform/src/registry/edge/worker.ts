/**
 * The registry edge function as a Cloudflare Worker (chant#4566). Bindings:
 *
 *   REGISTRY_BUCKET        an R2 bucket binding holding the registry's files, or
 *   REGISTRY_ORIGIN        the bucket's HTTP endpoint, when the files are elsewhere
 *   REGISTRY_PREFIX        the registry's prefix in the bucket (optional)
 *   REGISTRY_AUTH          "token" turns read auth on; anything else, or unset, leaves it off
 *   REGISTRY_TOKENS        a secret: the accepted tokens, one per line or comma separated
 *   REGISTRY_SIGNING_KEY   a secret: the key tarball URLs are signed with (default: the first token)
 *   REGISTRY_URL_TTL       seconds a signed tarball URL works (default 300)
 *
 * Rotating a token: add the new one to REGISTRY_TOKENS beside the old, move
 * the CLIs to it, then drop the old one. Rotating the signing key breaks only
 * signed URLs already handed out, which live for REGISTRY_URL_TTL seconds.
 *
 * No Node APIs, so it runs without the nodejs_compat flag.
 */
import type { RegistryFiles } from "../handler";
import { DEFAULT_SIGNED_TTL, originFiles, registryEdge, tokensFromSecret, type EdgeAuth } from "./edge";

/** The part of an R2 bucket binding the worker uses. */
export interface R2BucketLike {
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
}

export interface RegistryWorkerEnv {
  REGISTRY_BUCKET?: R2BucketLike;
  REGISTRY_ORIGIN?: string;
  REGISTRY_PREFIX?: string;
  REGISTRY_AUTH?: string;
  REGISTRY_TOKENS?: string;
  REGISTRY_SIGNING_KEY?: string;
  REGISTRY_URL_TTL?: string;
}

/** Files read from an R2 binding. */
export const r2Files = (bucket: R2BucketLike): RegistryFiles => async (key) => {
  const o = await bucket.get(key);
  return o ? { body: new Uint8Array(await o.arrayBuffer()) } : {};
};

/** Read auth from the worker's bindings, or undefined when it is off. */
export function workerAuth(env: RegistryWorkerEnv): EdgeAuth | undefined {
  if ((env.REGISTRY_AUTH ?? "").trim().toLowerCase() !== "token") return undefined;
  const ttl = Number(env.REGISTRY_URL_TTL);
  return {
    tokens: tokensFromSecret(env.REGISTRY_TOKENS),
    ...(env.REGISTRY_SIGNING_KEY ? { signingKey: env.REGISTRY_SIGNING_KEY } : {}),
    ttl: Number.isInteger(ttl) && ttl > 0 ? ttl : DEFAULT_SIGNED_TTL,
  };
}

/** Answers one request with the worker's bindings. */
export async function registryWorkerFetch(request: Request, env: RegistryWorkerEnv): Promise<Response> {
  const files = env.REGISTRY_BUCKET ? r2Files(env.REGISTRY_BUCKET) : env.REGISTRY_ORIGIN ? originFiles(env.REGISTRY_ORIGIN) : undefined;
  if (!files) return new Response("the registry worker needs a REGISTRY_BUCKET binding or REGISTRY_ORIGIN\n", { status: 500 });
  return registryEdge({ files, prefix: env.REGISTRY_PREFIX, auth: workerAuth(env) })(request);
}

/** The module a worker's entry file re-exports as its default. */
export const registryWorker = { fetch: registryWorkerFetch };
