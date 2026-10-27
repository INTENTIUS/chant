/**
 * A local emulator of every service the OIDC trade (#4296, ../ci-identity.ts)
 * talks to, for tests: the forge's token request URL, AWS STS, Google's STS
 * and IAM credentials, Entra's token endpoint, and Pulumi Cloud's OAuth
 * token exchange (#4549), a fake that never reaches api.pulumi.com. It answers with test
 * values only and keeps every request, so a test can say which identity
 * was asked for and how many tokens were minted.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { CloudTradeSpec } from "../ci-identity";

/** What the emulator was asked. */
export interface EmulatorLog {
  /** Each OIDC token minted: its audience. */
  minted: string[];
  /** Each AWS role assumed, with the token it was assumed with. */
  assumed: Array<{ role: string; token: string }>;
  /** Each GCP service account impersonated. */
  impersonated: string[];
  /** Each Azure client a token was traded for, with the token. */
  clients: Array<{ clientId: string; token: string }>;
  /** Each Pulumi Cloud token exchange (#4549): the token type and scope asked for, the exchange's audience, and the OIDC token. */
  pulumi: Array<{ tokenType: string; scope?: string; audience: string; token: string }>;
}

export interface OidcEmulator {
  url: string;
  log: EmulatorLog;
  /** The forge's token request variables, as a GitHub or Forgejo job with `id-token: write` has them. */
  requestEnv: { ACTIONS_ID_TOKEN_REQUEST_URL: string; ACTIONS_ID_TOKEN_REQUEST_TOKEN: string };
  /** `spec` with each cloud pointed at the emulator. */
  pointAt(spec: CloudTradeSpec): CloudTradeSpec;
  close(): Promise<void>;
}

/** The request token the emulator accepts, and the prefix of every token it mints. */
export const EMULATED_REQUEST_TOKEN = "emulated-oidc-request-token-4296";
export const EMULATED_JWT_PREFIX = "eyJemulated4296";

/** The test credentials the emulator hands out for an identity: they name it, so a test can tell which was traded. */
export function emulatedCredentials(identity: string): { accessKeyId: string; secret: string; token: string } {
  const tag = identity.replace(/[^A-Za-z0-9]/g, "").slice(-24);
  return { accessKeyId: `ASIATEST${tag}`, secret: `secret-${tag}`, token: `session-${tag}` };
}

/** The test Pulumi access token the emulator hands out for a Pulumi Cloud identity (#4549): it names the identity. */
export function emulatedPulumiToken(identity: string): string {
  return `pul-${emulatedCredentials(identity).token}`;
}

const body = (req: IncomingMessage): Promise<string> =>
  new Promise((ok) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => ok(b));
  });

/** Start the emulator on a free local port. */
export async function startOidcEmulator(): Promise<OidcEmulator> {
  const log: EmulatorLog = { minted: [], assumed: [], impersonated: [], clients: [], pulumi: [] };
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const text = await body(req);
    const send = (status: number, payload: unknown, type = "application/json") => {
      res.writeHead(status, { "content-type": type });
      res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
    };
    if (url.pathname === "/oidc") {
      if (req.headers.authorization !== `bearer ${EMULATED_REQUEST_TOKEN}`) return send(401, { message: "bad request token" });
      const aud = url.searchParams.get("audience") ?? "";
      log.minted.push(aud);
      return send(200, { value: `${EMULATED_JWT_PREFIX}.${Buffer.from(aud).toString("base64url")}.${log.minted.length}` });
    }
    if (url.pathname === "/aws/") {
      const form = new URLSearchParams(text);
      const role = form.get("RoleArn") ?? "";
      const token = form.get("WebIdentityToken") ?? "";
      if (form.get("Action") !== "AssumeRoleWithWebIdentity" || !token.startsWith("eyJ")) return send(400, "<Error>bad request</Error>", "text/xml");
      log.assumed.push({ role, token });
      const c = emulatedCredentials(role);
      return send(
        200,
        `<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult><Credentials><AccessKeyId>${c.accessKeyId}</AccessKeyId><SecretAccessKey>${c.secret}</SecretAccessKey><SessionToken>${c.token}</SessionToken><Expiration>2026-10-22T23:00:00Z</Expiration></Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`,
        "text/xml",
      );
    }
    if (url.pathname === "/gcp-sts/v1/token") {
      const j = JSON.parse(text) as { subjectToken?: string };
      if (!j.subjectToken?.startsWith("eyJ")) return send(400, { error: "bad subject token" });
      return send(200, { access_token: "federated-test-token", token_type: "Bearer" });
    }
    const sa = /^\/gcp-iam\/v1\/projects\/-\/serviceAccounts\/([^/:]+):generateAccessToken$/.exec(url.pathname);
    if (sa) {
      if (req.headers.authorization !== "Bearer federated-test-token") return send(401, { error: "bad federated token" });
      const name = decodeURIComponent(sa[1]!);
      log.impersonated.push(name);
      return send(200, { accessToken: `ya29.${emulatedCredentials(name).token}`, expireTime: "2026-10-22T23:00:00Z" });
    }
    if (/^\/azure\/[^/]+\/oauth2\/v2\.0\/token$/.test(url.pathname)) {
      const form = new URLSearchParams(text);
      const clientId = form.get("client_id") ?? "";
      const token = form.get("client_assertion") ?? "";
      if (form.get("grant_type") !== "client_credentials" || !token.startsWith("eyJ")) return send(400, { error: "bad grant" });
      log.clients.push({ clientId, token });
      return send(200, { access_token: `azure.${emulatedCredentials(clientId).token}`, token_type: "Bearer" });
    }
    if (url.pathname === "/pulumi/api/oauth/token") {
      const form = new URLSearchParams(text);
      const token = form.get("subject_token") ?? "";
      const tokenType = form.get("requested_token_type") ?? "";
      const audience = form.get("audience") ?? "";
      if (
        form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:token-exchange" ||
        form.get("subject_token_type") !== "urn:ietf:params:oauth:token-type:id_token" ||
        !tokenType.startsWith("urn:pulumi:token-type:access_token:") ||
        !audience.startsWith("urn:pulumi:org:") ||
        !token.startsWith("eyJ")
      ) {
        return send(400, { error: "invalid_request" });
      }
      const scope = form.get("scope") ?? undefined;
      log.pulumi.push({ tokenType, ...(scope !== undefined ? { scope } : {}), audience, token });
      const kind = tokenType.slice("urn:pulumi:token-type:access_token:".length);
      const identity = kind === "organization" ? (scope === "admin" ? "organization:admin" : "organization") : (scope ?? "");
      return send(200, { access_token: emulatedPulumiToken(identity), issued_token_type: tokenType, token_type: "Bearer", expires_in: 7200, scope: scope ?? "" });
    }
    send(404, { message: `no route ${url.pathname}` });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    log,
    requestEnv: { ACTIONS_ID_TOKEN_REQUEST_URL: `${url}/oidc?api-version=2.0`, ACTIONS_ID_TOKEN_REQUEST_TOKEN: EMULATED_REQUEST_TOKEN },
    pointAt(spec) {
      return {
        ...(spec.aws ? { aws: { ...spec.aws, endpoint: `${url}/aws` } } : {}),
        ...(spec.gcp ? { gcp: { ...spec.gcp, stsEndpoint: `${url}/gcp-sts`, iamEndpoint: `${url}/gcp-iam` } } : {}),
        ...(spec.azure ? { azure: { ...spec.azure, authority: `${url}/azure` } } : {}),
        ...(spec.pulumi ? { pulumi: { ...spec.pulumi, apiUrl: `${url}/pulumi` } } : {}),
      };
    },
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}
