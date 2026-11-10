/**
 * Test support for keyless runner statements (#4869): a fake forge token
 * service, a fake Fulcio certificate authority and a fake RFC 3161
 * timestamp authority, all answered by one `fetch` that never leaves the
 * process. The certificates and timestamps are real DER, signed with keys
 * made here, so ./keyless.ts verifies them as it would sigstore's. The
 * clock is the fixture's, so a test can sign in the past and verify after
 * the certificate expired.
 */

import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, X509Certificate, type KeyObject } from "node:crypto";
import { DER, der, derChildren, derInt, derOid, derRead, OID } from "./keyless";

const ECDSA_SHA256 = "1.2.840.10045.4.3.2";
const CN = "2.5.4.3";

const name = (cn: string): Buffer => der(DER.SEQUENCE, der(DER.SET, der(DER.SEQUENCE, derOid(CN), der(DER.UTF8, Buffer.from(cn)))));
const algId = (oid: string, withNull = false): Buffer => der(DER.SEQUENCE, derOid(oid), ...(withNull ? [der(DER.NULL)] : []));
const ext = (oid: string, critical: boolean, value: Buffer): Buffer => der(DER.SEQUENCE, derOid(oid), ...(critical ? [der(DER.BOOLEAN, Buffer.from([0xff]))] : []), der(DER.OCTET_STRING, value));

function utcTime(d: Date): Buffer {
  const iso = d.toISOString();
  return der(DER.UTC_TIME, Buffer.from(`${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`));
}

function generalized(d: Date): Buffer {
  const iso = d.toISOString();
  return der(DER.GENERALIZED_TIME, Buffer.from(`${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`));
}

interface Issued {
  cert: X509Certificate;
  der: Buffer;
  key?: KeyObject;
  cn: string;
}

/** A certificate for `publicKey`, signed by `issuer` (or by `selfKey`, self-signed). */
function certificate(opts: { cn: string; publicKey: KeyObject; issuer?: Issued; signKey: KeyObject; notBefore: Date; notAfter: Date; extensions: Buffer[] }): Buffer {
  const tbs = der(
    DER.SEQUENCE,
    der(0xa0, derInt(2)),
    derInt(randomBytes(8)),
    algId(ECDSA_SHA256),
    name(opts.issuer?.cn ?? opts.cn),
    der(DER.SEQUENCE, utcTime(opts.notBefore), utcTime(opts.notAfter)),
    name(opts.cn),
    opts.publicKey.export({ format: "der", type: "spki" }) as Buffer,
    der(0xa3, der(DER.SEQUENCE, ...opts.extensions)),
  );
  return der(DER.SEQUENCE, tbs, algId(ECDSA_SHA256), der(DER.BIT_STRING, Buffer.from([0]), sign("sha256", tbs, opts.signKey)));
}

const CA_EXTENSIONS = [ext("2.5.29.19", true, der(DER.SEQUENCE, der(DER.BOOLEAN, Buffer.from([0xff])))), ext("2.5.29.15", true, der(DER.BIT_STRING, Buffer.from([1, 0x06])))];

function authority(cn: string, notBefore: Date): Issued {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const bytes = certificate({ cn, publicKey, signKey: privateKey, notBefore, notAfter: new Date(notBefore.getTime() + 30 * 365 * 86400_000), extensions: CA_EXTENSIONS });
  return { cert: new X509Certificate(bytes), der: bytes, key: privateKey, cn };
}

/** A fake forge OIDC token with `claims`: a JWT whose signature nothing checks but the fake authority. */
export function fakeToken(claims: Record<string, unknown>): string {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "RS256", typ: "JWT" })}.${part(claims)}.fake-signature-4869`;
}

/** The claims of a GitHub Actions job's token for `workflow` of `repository` at `ref`. */
export function githubClaims(repository: string, workflow: string, ref: string): Record<string, unknown> {
  return {
    iss: FAKE_GITHUB_ISSUER,
    sub: `repo:${repository}:ref:${ref}`,
    aud: "sigstore",
    repository,
    ref,
    job_workflow_ref: `${repository}/.github/workflows/${workflow}@${ref}`,
  };
}

/** The issuer the fake authority accepts GitHub-shaped tokens from. */
export const FAKE_GITHUB_ISSUER = "https://token.actions.githubusercontent.com";

export const FAKE_FULCIO_URL = "https://fulcio.fake.test";
export const FAKE_TSA_URL = "https://tsa.fake.test/api/v1/timestamp";
export const FAKE_TOKEN_URL = "https://forge.fake.test/oidc/token?api-version=2.0";
export const FAKE_REQUEST_TOKEN = "fake-request-token-4869";

/** What the fakes were asked. */
export interface SigstoreFakeLog {
  tokens: string[];
  certificates: string[];
  timestamps: number;
}

export interface SigstoreFake {
  /** Answers the forge's token URL, Fulcio and the timestamp authority. Anything else is refused. */
  fetch: typeof fetch;
  /** The trusted root, in sigstore's `trusted_root.json` format. */
  trustedRoot: string;
  /** The environment of a GitHub job with `id-token: write`, whose token carries `claims`. */
  jobEnv(claims: Record<string, unknown>): NodeJS.ProcessEnv;
  log: SigstoreFakeLog;
  /** Sets the time the authorities issue and stamp at. */
  setNow(d: Date): void;
}

/** Start the fakes. `now` is the authorities' clock; the authorities' own certificates are valid from 2020 for 30 years. */
export function sigstoreFake(opts: { now?: Date } = {}): SigstoreFake {
  let now = opts.now ?? new Date();
  const epoch = new Date("2020-01-01T00:00:00Z");
  const ca = authority("fake fulcio root 4869", epoch);
  const tsaRoot = authority("fake tsa root 4869", epoch);
  const tsaPair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const tsaDer = certificate({
    cn: "fake tsa 4869",
    publicKey: tsaPair.publicKey,
    issuer: tsaRoot,
    signKey: tsaRoot.key!,
    notBefore: epoch,
    notAfter: new Date(epoch.getTime() + 30 * 365 * 86400_000),
    extensions: [ext("2.5.29.37", true, der(DER.SEQUENCE, derOid(OID.timeStamping)))],
  });
  const tsa: Issued = { cert: new X509Certificate(tsaDer), der: tsaDer, key: tsaPair.privateKey, cn: "fake tsa 4869" };
  const log: SigstoreFakeLog = { tokens: [], certificates: [], timestamps: 0 };
  const pending = new Map<string, string>();

  const pem = (b: Buffer) => `-----BEGIN CERTIFICATE-----\n${b.toString("base64").replace(/(.{64})/g, "$1\n")}\n-----END CERTIFICATE-----\n`;

  const issueLeaf = (body: string): Response => {
    const req = JSON.parse(body) as { credentials: { oidcIdentityToken: string }; publicKeyRequest: { publicKey: { content: string }; proofOfPossession: string } };
    const token = req.credentials.oidcIdentityToken;
    const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) as Record<string, string>;
    if (claims.iss !== FAKE_GITHUB_ISSUER || claims.aud !== "sigstore") return new Response("token refused", { status: 401 });
    const publicKey = createPublicKey(req.publicKeyRequest.publicKey.content);
    if (!verify("sha256", Buffer.from(claims.sub!), publicKey, Buffer.from(req.publicKeyRequest.proofOfPossession, "base64"))) return new Response("no proof of possession", { status: 400 });
    const san = `https://github.com/${claims.job_workflow_ref}`;
    log.certificates.push(san);
    const leaf = certificate({
      cn: "sigstore",
      publicKey,
      issuer: ca,
      signKey: ca.key!,
      notBefore: now,
      notAfter: new Date(now.getTime() + 10 * 60_000),
      extensions: [
        ext("2.5.29.15", true, der(DER.BIT_STRING, Buffer.from([7, 0x80]))),
        ext("2.5.29.37", false, der(DER.SEQUENCE, derOid(OID.codeSigning))),
        ext("2.5.29.17", true, der(DER.SEQUENCE, der(0x86, Buffer.from(san)))),
        ext(OID.fulcioIssuerV1, false, Buffer.from(claims.iss!)),
        ext(OID.fulcioIssuerV2, false, der(DER.UTF8, Buffer.from(claims.iss!))),
      ],
    });
    return Response.json({ signedCertificateEmbeddedSct: { chain: { certificates: [pem(leaf), pem(ca.der)] } } });
  };

  const stamp = (body: Buffer): Response => {
    const req = derChildren(derRead(body));
    const imprint = derChildren(req[1]!);
    const hashed = imprint[1]!.value;
    log.timestamps++;
    const tstInfo = der(DER.SEQUENCE, derInt(1), derOid("1.2.3.4.4869"), der(DER.SEQUENCE, algId(OID.sha256, true), der(DER.OCTET_STRING, hashed)), derInt(randomBytes(8)), generalized(now));
    const attrs = [
      der(DER.SEQUENCE, derOid(OID.contentType), der(DER.SET, derOid(OID.tstInfo))),
      der(DER.SEQUENCE, derOid(OID.messageDigest), der(DER.SET, der(DER.OCTET_STRING, createHash("sha256").update(tstInfo).digest()))),
    ];
    const signature = sign("sha256", der(DER.SET, ...attrs), tsa.key!);
    const issuerSerial = derChildren(derChildren(derRead(tsa.der))[0]!);
    const signerInfo = der(DER.SEQUENCE, derInt(1), der(DER.SEQUENCE, issuerSerial[3]!.raw, issuerSerial[1]!.raw), algId(OID.sha256), der(0xa0, ...attrs), algId(ECDSA_SHA256), der(DER.OCTET_STRING, signature));
    const signedData = der(DER.SEQUENCE, derInt(3), der(DER.SET, algId(OID.sha256)), der(DER.SEQUENCE, derOid(OID.tstInfo), der(0xa0, der(DER.OCTET_STRING, tstInfo))), der(0xa0, tsa.der), der(DER.SET, signerInfo));
    const token = der(DER.SEQUENCE, derOid(OID.signedData), der(0xa0, signedData));
    return new Response(new Uint8Array(der(DER.SEQUENCE, der(DER.SEQUENCE, derInt(0)), token)), { headers: { "content-type": "application/timestamp-reply" } });
  };

  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers);
    if (url.startsWith(FAKE_TOKEN_URL)) {
      if (headers.get("authorization") !== `bearer ${FAKE_REQUEST_TOKEN}`) return new Response("no", { status: 403 });
      const id = new URL(url).searchParams.get("job") ?? "";
      const claims = pending.get(id);
      if (!claims) return new Response("unknown job", { status: 404 });
      const audience = new URL(url).searchParams.get("audience");
      log.tokens.push(audience ?? "");
      return Response.json({ value: fakeToken({ ...JSON.parse(claims), aud: audience }) });
    }
    if (url === `${FAKE_FULCIO_URL}/api/v2/signingCert`) return issueLeaf(String(init?.body));
    if (url === FAKE_TSA_URL) return stamp(Buffer.from(init?.body as Uint8Array));
    throw new Error(`the sigstore fake refuses ${url}: a test never reaches a real service`);
  }) as typeof fetch;

  const trustedRoot = JSON.stringify(
    {
      mediaType: "application/vnd.dev.sigstore.trustedroot+json;version=0.1",
      certificateAuthorities: [{ uri: FAKE_FULCIO_URL, certChain: { certificates: [{ rawBytes: ca.der.toString("base64") }] }, validFor: { start: epoch.toISOString() } }],
      timestampAuthorities: [{ uri: FAKE_TSA_URL, certChain: { certificates: [{ rawBytes: tsa.der.toString("base64") }, { rawBytes: tsaRoot.der.toString("base64") }] }, validFor: { start: epoch.toISOString() } }],
    },
    null,
    2,
  );

  return {
    fetch: fakeFetch,
    trustedRoot,
    log,
    setNow: (d) => {
      now = d;
    },
    jobEnv: (claims) => {
      const id = String(pending.size + 1);
      pending.set(id, JSON.stringify(claims));
      return { ACTIONS_ID_TOKEN_REQUEST_URL: `${FAKE_TOKEN_URL}&job=${id}`, ACTIONS_ID_TOKEN_REQUEST_TOKEN: FAKE_REQUEST_TOKEN };
    },
  };
}
