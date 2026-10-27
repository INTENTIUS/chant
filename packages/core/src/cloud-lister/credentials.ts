/**
 * behold#1029: where the lister's credentials come from.
 *
 * The goal's hard rule: against an emulator the lister takes explicit
 * endpoints and static credentials only, and never the AWS SDK's default
 * provider chain, Azure's DefaultAzureCredential or google-auth's
 * application-default credentials. So:
 *
 *  - a target that names an `endpoint` must carry its credentials (a static
 *    AWS key pair, an Azure bearer token, a GCP token or an explicit `null`
 *    for an anonymous emulator). Without them the run is refused with
 *    {@link ListerConfigError}, and no chain is loaded;
 *  - only a target with no endpoint (a real cloud, which the maintainer runs)
 *    may fall back to a cloud SDK's chain. Those SDKs are optional peers,
 *    imported lazily by name, so chant's install and bundle do not grow for
 *    people who never index; their absence is a clear error naming the
 *    package.
 *
 * The lister itself reads no environment variable. `chant index` (chant#4532)
 * turns its flags into these targets.
 */

export class ListerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ListerConfigError";
  }
}

export interface AwsStaticCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** The SDK chains a real-cloud run may use; replaced in tests so a test can prove none was touched. */
export interface CredentialChains {
  aws(): Promise<AwsStaticCredentials>;
  azure(): Promise<string>;
  gcp(): Promise<string>;
}

/** Imports a module by a name the bundler and the type checker do not follow. */
async function optionalPeer(name: string): Promise<Record<string, unknown>> {
  const specifier = name;
  try {
    return (await import(specifier)) as Record<string, unknown>;
  } catch {
    throw new ListerConfigError(`listing a real cloud without explicit credentials needs the optional package ${name}; install it beside chant, or pass credentials`);
  }
}

type AnyFn = (...args: unknown[]) => unknown;

export const sdkCredentialChains: CredentialChains = {
  async aws() {
    const mod = await optionalPeer("@aws-sdk/credential-providers");
    const chain = (mod.fromNodeProviderChain as AnyFn)() as () => Promise<AwsStaticCredentials>;
    const c = await chain();
    return { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, ...(c.sessionToken ? { sessionToken: c.sessionToken } : {}) };
  },
  async azure() {
    const mod = await optionalPeer("@azure/identity");
    const Ctor = mod.DefaultAzureCredential as new () => { getToken(scope: string): Promise<{ token: string } | null> };
    const t = await new Ctor().getToken("https://management.azure.com/.default");
    if (!t) throw new ListerConfigError("DefaultAzureCredential returned no token");
    return t.token;
  },
  async gcp() {
    const mod = await optionalPeer("google-auth-library");
    const Ctor = mod.GoogleAuth as new (o: { scopes: string[] }) => { getAccessToken(): Promise<string | null | undefined> };
    const t = await new Ctor({ scopes: ["https://www.googleapis.com/auth/cloud-platform.read-only"] }).getAccessToken();
    if (!t) throw new ListerConfigError("google-auth returned no access token");
    return t;
  },
};

export async function resolveAwsCredentials(
  target: { endpoint?: string; credentials?: AwsStaticCredentials },
  chains: CredentialChains,
): Promise<AwsStaticCredentials> {
  if (target.credentials) return target.credentials;
  if (target.endpoint !== undefined) {
    throw new ListerConfigError(`aws endpoint ${target.endpoint} needs static credentials (accessKeyId and secretAccessKey); the default provider chain is never used with an endpoint`);
  }
  return chains.aws();
}

export async function resolveAzureToken(
  target: { endpoint?: string; token?: string },
  chains: CredentialChains,
): Promise<string> {
  if (target.token !== undefined) return target.token;
  if (target.endpoint !== undefined) {
    throw new ListerConfigError(`azure endpoint ${target.endpoint} needs a static bearer token; DefaultAzureCredential is never used with an endpoint`);
  }
  return chains.azure();
}

/** `null` is an explicit anonymous call (floci-gcp with IAM enforcement off). */
export async function resolveGcpToken(
  target: { endpoint?: string; token?: string | null },
  chains: CredentialChains,
): Promise<string | null> {
  if (target.token !== undefined) return target.token;
  if (target.endpoint !== undefined) {
    throw new ListerConfigError(`gcp endpoint ${target.endpoint} needs a static token, or token: null for an anonymous emulator; application-default credentials are never used with an endpoint`);
  }
  return chains.gcp();
}
