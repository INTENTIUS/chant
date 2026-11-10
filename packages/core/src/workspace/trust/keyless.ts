/**
 * Runner statements signed keyless from the CI job's OIDC identity (#4869).
 *
 * A runner key is a secret a project stores and rotates, and a leaked one
 * signs anything until someone does. A keyless runner holds no key: the job
 * trades its OIDC token for a short-lived certificate from a Fulcio
 * certificate authority (sigstore's, or a private one), signs the DSSE
 * envelope with a key it made for this run, and has the signature
 * timestamped by an RFC 3161 timestamp authority. The envelope's signature
 * then carries the certificate chain and the timestamp token:
 *
 *   { keyid, sig, certificates: [<base64 DER>, ...], timestamp: <base64 DER> }
 *
 * `.chant/trust.json` at base lists which identities may sign
 * (`keyless.identities`: an OIDC issuer and a subject pattern over the
 * certificate's subject alternative name, which names the repository, the
 * workflow file and the ref), and names the trusted root, a file in
 * sigstore's `trusted_root.json` format holding the certificate
 * authorities' and timestamp authorities' certificates. So verifying is
 * offline: the chain is checked against the trusted root, the timestamp
 * against the timestamp authorities, and the certificate's validity at the
 * timestamp's time, never at the time of reading. A statement still
 * verifies after its certificate expired.
 *
 * Nothing is sent to a transparency log.
 *
 * Every network call goes through an injected `fetch`, so the tests use a
 * fake token, a fake certificate authority and a fake timestamp authority
 * (./keyless-fixture.ts).
 */

import { createHash, createPublicKey, generateKeyPairSync, sign, verify, X509Certificate, type KeyObject } from "node:crypto";
import { SIGNING_ID_TOKEN_VAR } from "./check-evidence-report";

// ── DER, as much as certificates and RFC 3161 need ──────────────────────────

/** One DER element: its tag, its whole encoding and its contents. */
export interface DerNode {
  tag: number;
  /** The whole element, tag and length included. */
  raw: Buffer;
  /** The contents. */
  value: Buffer;
}

/** The element at `at` in `buf`. Throws on a truncated or indefinite-length element. */
export function derRead(buf: Buffer, at = 0): DerNode & { end: number } {
  if (at + 2 > buf.length) throw new Error("truncated DER");
  const tag = buf[at]!;
  let len = buf[at + 1]!;
  let head = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || at + 2 + n > buf.length) throw new Error("unsupported DER length");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[at + 2 + i]!;
    head = 2 + n;
  }
  const end = at + head + len;
  if (end > buf.length) throw new Error("truncated DER");
  return { tag, raw: buf.subarray(at, end), value: buf.subarray(at + head, end), end };
}

/** The elements inside a constructed element. */
export function derChildren(node: DerNode): DerNode[] {
  const out: DerNode[] = [];
  let at = 0;
  while (at < node.value.length) {
    const c = derRead(node.value, at);
    out.push(c);
    at = c.end;
  }
  return out;
}

/** A DER element of `tag` holding `parts`. */
export function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const n = body.length;
  const len = n < 0x80 ? Buffer.from([n]) : n < 0x100 ? Buffer.from([0x81, n]) : n < 0x10000 ? Buffer.from([0x82, n >> 8, n & 0xff]) : Buffer.from([0x83, n >> 16, (n >> 8) & 0xff, n & 0xff]);
  return Buffer.concat([Buffer.from([tag]), len, body]);
}

export const DER = { SEQUENCE: 0x30, SET: 0x31, INTEGER: 0x02, BIT_STRING: 0x03, OCTET_STRING: 0x04, NULL: 0x05, OID: 0x06, UTF8: 0x0c, BOOLEAN: 0x01, UTC_TIME: 0x17, GENERALIZED_TIME: 0x18 } as const;

/** An OBJECT IDENTIFIER's encoding. */
export function derOid(oid: string): Buffer {
  const parts = oid.split(".").map(Number);
  const bytes = [parts[0]! * 40 + parts[1]!];
  for (const p of parts.slice(2)) {
    const seven: number[] = [];
    let v = p;
    do {
      seven.unshift(v & 0x7f);
      v = Math.floor(v / 128);
    } while (v > 0);
    for (let i = 0; i < seven.length - 1; i++) seven[i]! |= 0x80;
    bytes.push(...seven);
  }
  return der(DER.OID, Buffer.from(bytes));
}

/** The dotted form of an OBJECT IDENTIFIER's contents. */
export function oidOf(value: Buffer): string {
  const out = [Math.floor(value[0]! / 40), value[0]! % 40];
  let v = 0;
  for (const b of value.subarray(1)) {
    v = v * 128 + (b & 0x7f);
    if (!(b & 0x80)) {
      out.push(v);
      v = 0;
    }
  }
  return out.join(".");
}

/** A non-negative INTEGER. */
export function derInt(n: number | bigint | Buffer): Buffer {
  let hex = Buffer.isBuffer(n) ? "" : BigInt(n).toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  let b = Buffer.isBuffer(n) ? n : Buffer.from(hex, "hex");
  if (b.length === 0) b = Buffer.from([0]);
  if (b[0]! & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return der(DER.INTEGER, b);
}

export const OID = {
  sha256: "2.16.840.1.101.3.4.2.1",
  sha384: "2.16.840.1.101.3.4.2.2",
  sha512: "2.16.840.1.101.3.4.2.3",
  signedData: "1.2.840.113549.1.7.2",
  tstInfo: "1.2.840.113549.1.9.16.1.4",
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  /** Fulcio's OIDC issuer extension, v1 (raw string) and v2 (DER UTF8String). */
  fulcioIssuerV1: "1.3.6.1.4.1.57264.1.1",
  fulcioIssuerV2: "1.3.6.1.4.1.57264.1.8",
  codeSigning: "1.3.6.1.5.5.7.3.3",
  timeStamping: "1.3.6.1.5.5.7.3.8",
} as const;

const HASH_OF: Record<string, string> = { [OID.sha256]: "sha256", [OID.sha384]: "sha384", [OID.sha512]: "sha512" };

// ── The trusted root ─────────────────────────────────────────────────────────

/** A certificate authority or timestamp authority of the trusted root: its chain, and when it may be used. */
export interface KeylessAuthority {
  certs: X509Certificate[];
  start?: Date;
  end?: Date;
}

/** What a keyless signature is verified against: sigstore's `trusted_root.json`, read at base. */
export interface KeylessRoots {
  ca: KeylessAuthority[];
  tsa: KeylessAuthority[];
}

function authorities(list: unknown, name: string): KeylessAuthority[] {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new Error(`${name} is not a list`);
  return list.map((a, i) => {
    const raw = (a as { certChain?: { certificates?: Array<{ rawBytes?: unknown }> } })?.certChain?.certificates;
    if (!Array.isArray(raw) || raw.length === 0) throw new Error(`${name}[${i}] has no certChain.certificates`);
    const certs = raw.map((c, j) => {
      if (typeof c?.rawBytes !== "string") throw new Error(`${name}[${i}].certChain.certificates[${j}] has no rawBytes`);
      return new X509Certificate(Buffer.from(c.rawBytes, "base64"));
    });
    const valid = (a as { validFor?: { start?: unknown; end?: unknown } }).validFor;
    return {
      certs,
      ...(typeof valid?.start === "string" ? { start: new Date(valid.start) } : {}),
      ...(typeof valid?.end === "string" ? { end: new Date(valid.end) } : {}),
    };
  });
}

/**
 * The certificate and timestamp authorities of a `trusted_root.json`
 * (`certificateAuthorities` and `timestampAuthorities`, each a `certChain`
 * of base64 DER certificates and an optional `validFor`). Throws when the
 * file is not one, or names no certificate authority.
 */
export function parseTrustedRoot(text: string): KeylessRoots {
  const doc = JSON.parse(text) as { certificateAuthorities?: unknown; timestampAuthorities?: unknown };
  const ca = authorities(doc.certificateAuthorities, "certificateAuthorities");
  const tsa = authorities(doc.timestampAuthorities, "timestampAuthorities");
  if (ca.length === 0) throw new Error("it lists no certificateAuthorities");
  if (tsa.length === 0) throw new Error("it lists no timestampAuthorities, so no signature's time can be trusted");
  return { ca, tsa };
}

// ── Identities ───────────────────────────────────────────────────────────────

/** A CI identity `.chant/trust.json` lets sign runner statements keyless (#4869). */
export interface TrustedIdentity {
  principal: string;
  /** The OIDC issuer the certificate names, exactly. */
  issuer: string;
  /**
   * A pattern over the certificate's subject alternative name, such as
   * `https://github.com/acme/infra/.github/workflows/chant.yml@refs/heads/main`.
   * `*` matches within one `/` segment, `**` across them.
   */
  subject: string;
  roots: KeylessRoots;
}

/** A subject pattern as a regular expression: `**` any text, `*` any text without `/`. */
export function subjectPattern(pattern: string): RegExp {
  const body = pattern
    .split("**")
    .map((part) => part.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*"))
    .join(".*");
  return new RegExp(`^${body}$`);
}

/** The URIs and emails of a certificate's subject alternative name. */
export function certificateSubjects(cert: X509Certificate): string[] {
  const san = cert.subjectAltName ?? "";
  return san
    .split(/, (?=[A-Za-z ]+:)/)
    .map((s) => s.match(/^(?:URI|email):(.*)$/)?.[1])
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .map((s) => (s.startsWith('"') && s.endsWith('"') ? (JSON.parse(s) as string) : s));
}

/** The extensions of a certificate, by OID: each one's OCTET STRING contents. */
function extensions(cert: X509Certificate): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const tbs = derChildren(derRead(cert.raw))[0]!;
  const wrapper = derChildren(tbs).find((c) => c.tag === 0xa3);
  if (!wrapper) return out;
  for (const ext of derChildren(derChildren(wrapper)[0]!)) {
    const parts = derChildren(ext);
    const value = parts[parts.length - 1]!;
    out.set(oidOf(parts[0]!.value), value.value);
  }
  return out;
}

/** The OIDC issuer Fulcio wrote into the certificate, or undefined. */
export function certificateIssuer(cert: X509Certificate): string | undefined {
  const ext = extensions(cert);
  const v2 = ext.get(OID.fulcioIssuerV2);
  if (v2) return derRead(v2).value.toString("utf8");
  return ext.get(OID.fulcioIssuerV1)?.toString("utf8");
}

// ── Chains and timestamps ────────────────────────────────────────────────────

const within = (cert: X509Certificate, at: Date): boolean => new Date(cert.validFrom) <= at && at <= new Date(cert.validTo);

/**
 * Whether `leaf` chains, through `given` and the authorities' own
 * certificates, to one of `authorities` whose `validFor` covers `at`, with
 * every certificate on the way valid at `at`. Every certificate of an
 * authority's chain is trusted, as sigstore's clients treat them.
 */
export function chainsTo(leaf: X509Certificate, given: readonly X509Certificate[], list: readonly KeylessAuthority[], at: Date): boolean {
  for (const a of list) {
    if ((a.start && at < a.start) || (a.end && at > a.end)) continue;
    const anchors = new Set(a.certs.map((c) => c.fingerprint256));
    const pool = [...given, ...a.certs];
    let cur = leaf;
    for (let depth = 0; depth < 8; depth++) {
      if (!within(cur, at)) break;
      if (anchors.has(cur.fingerprint256)) return true;
      const issuer = pool.find((p) => p.fingerprint256 !== cur.fingerprint256 && cur.checkIssued(p) && cur.verify(p.publicKey));
      if (!issuer) break;
      cur = issuer;
    }
  }
  return false;
}

/** A GeneralizedTime's contents as a Date: `YYYYMMDDHHMMSS[.fff]Z`. */
function generalizedTime(value: Buffer): Date {
  const m = value.toString("ascii").match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\.\d+)?Z$/);
  if (!m) throw new Error("the timestamp's time is not a GeneralizedTime in UTC");
  return new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!, m[7] ? Math.round(Number(m[7]) * 1000) : 0));
}

/** What a timestamp token says, read without verifying. */
interface TimestampToken {
  time: Date;
  imprintHash: string;
  imprint: Buffer;
  eContent: Buffer;
  digest: string;
  signedAttrs: Buffer;
  signature: Buffer;
  certs: X509Certificate[];
}

/** Read an RFC 3161 TimeStampToken (a CMS ContentInfo), or the TimeStampResp around one. */
function readTimestamp(bytes: Buffer): TimestampToken {
  let top: DerNode = derRead(bytes);
  let parts = derChildren(top);
  // A TimeStampResp: status, then the token.
  if (parts[0]?.tag === DER.SEQUENCE && parts[1]?.tag === DER.SEQUENCE) {
    const status = derChildren(parts[0])[0];
    if (!status || status.value.readUIntBE(0, status.value.length) > 1) throw new Error("the timestamp authority did not grant the timestamp");
    top = parts[1];
    parts = derChildren(top);
  }
  if (parts[0]?.tag !== DER.OID || oidOf(parts[0].value) !== OID.signedData) throw new Error("the timestamp is not CMS SignedData");
  const signed = derChildren(derChildren(parts[1]!)[0]!);
  const encap = derChildren(signed[2]!);
  if (oidOf(encap[0]!.value) !== OID.tstInfo) throw new Error("the timestamp's content is not a TSTInfo");
  const eContent = derChildren(encap[1]!)[0]!.value;
  const tst = derChildren(derRead(eContent));
  const imprint = derChildren(tst[2]!);
  const imprintHash = HASH_OF[oidOf(derChildren(imprint[0]!)[0]!.value)];
  if (!imprintHash) throw new Error("the timestamp's message imprint uses a hash chant does not read");
  const time = generalizedTime(tst[4]!.value);
  const certField = signed.find((c) => c.tag === 0xa0);
  const certs = certField ? derChildren(certField).filter((c) => c.tag === DER.SEQUENCE).map((c) => new X509Certificate(c.raw)) : [];
  const signerInfos = signed[signed.length - 1]!;
  if (signerInfos.tag !== DER.SET) throw new Error("the timestamp has no signer");
  const si = derChildren(derChildren(signerInfos)[0]!);
  const digest = HASH_OF[oidOf(derChildren(si[2]!)[0]!.value)];
  const attrs = si.find((c) => c.tag === 0xa0);
  const signature = si.find((c, i) => i > 3 && c.tag === DER.OCTET_STRING);
  if (!digest || !attrs || !signature) throw new Error("the timestamp's signer has no signed attributes or signature");
  // The signature covers the attributes encoded as a SET, not as the [0] they are stored as.
  const signedAttrs = Buffer.concat([Buffer.from([DER.SET]), attrs.raw.subarray(1)]);
  const md = derChildren(attrs).find((a) => oidOf(derChildren(a)[0]!.value) === OID.messageDigest);
  if (!md || !derChildren(derChildren(md)[1]!)[0]!.value.equals(createHash(digest).update(eContent).digest())) {
    throw new Error("the timestamp's signed attributes do not match its TSTInfo");
  }
  return { time, imprintHash, imprint: imprint[1]!.value, eContent, digest, signedAttrs, signature: signature.value, certs };
}

const usableFor = (cert: X509Certificate, eku: string): boolean => !cert.keyUsage || cert.keyUsage.includes(eku);

/**
 * The time a timestamp token vouches `signature` existed at, once the
 * token's imprint is the signature's hash and a timestamp authority of
 * `roots` signed it. Throws why not.
 */
export function verifyTimestamp(token: Buffer, signature: Buffer, roots: KeylessRoots): Date {
  const t = readTimestamp(token);
  if (!t.imprint.equals(createHash(t.imprintHash).update(signature).digest())) throw new Error("the timestamp is for another signature");
  const candidates = [...t.certs, ...roots.tsa.flatMap((a) => a.certs)];
  const signer = candidates.find((c) => {
    try {
      return verify(c.publicKey.asymmetricKeyType === "ed25519" ? null : t.digest, t.signedAttrs, c.publicKey, t.signature);
    } catch {
      return false;
    }
  });
  if (!signer) throw new Error("no timestamp authority's certificate verifies the timestamp's signature");
  if (!usableFor(signer, OID.timeStamping)) throw new Error("the timestamp was signed by a certificate not issued for timestamping");
  if (!chainsTo(signer, t.certs, roots.tsa, t.time)) throw new Error("the timestamp's signer does not chain to a timestamp authority of the trusted root");
  return t.time;
}

// ── Verify ───────────────────────────────────────────────────────────────────

/** A DSSE signature made keyless: the DSSE fields and the certificate chain and timestamp. */
export interface KeylessSignature {
  keyid: string;
  sig: string;
  /** Base64 DER, the signing certificate first. */
  certificates: string[];
  /** Base64 DER RFC 3161 TimeStampToken over `sig`'s bytes. */
  timestamp: string;
}

export function isKeylessSignature(s: unknown): s is KeylessSignature {
  const k = s as Partial<KeylessSignature> | null;
  return (
    k !== null &&
    typeof k === "object" &&
    typeof k.sig === "string" &&
    typeof k.timestamp === "string" &&
    Array.isArray(k.certificates) &&
    k.certificates.length > 0 &&
    k.certificates.every((c) => typeof c === "string")
  );
}

/** The key id a keyless signature is given: its certificate's SHA-256 fingerprint. */
export function certificateKeyid(cert: X509Certificate): string {
  return `x509:SHA256:${createHash("sha256").update(cert.raw).digest("base64").replace(/=+$/, "")}`;
}

export type KeylessVerdict =
  | { ok: true; principal: string; keyid: string; issuer: string; subject: string; signedAt: string }
  | { ok: false; reason: string };

/**
 * Verify one keyless signature over `message` (the envelope's PAE) against
 * `identities`. The certificate must chain to the trusted root and be valid
 * at the timestamp's time, the timestamp must verify, and the certificate's
 * issuer and subject must match one identity, whose principal is returned.
 */
export function verifyKeylessSignature(message: Buffer, s: KeylessSignature, identities: readonly TrustedIdentity[]): KeylessVerdict {
  if (identities.length === 0) return { ok: false, reason: "the policy at base lists no keyless identity" };
  let leaf: X509Certificate;
  let chain: X509Certificate[];
  try {
    [leaf, ...chain] = s.certificates.map((c) => new X509Certificate(Buffer.from(c, "base64"))) as [X509Certificate, ...X509Certificate[]];
  } catch (err) {
    return { ok: false, reason: `the signature's certificates do not parse: ${err instanceof Error ? err.message : String(err)}` };
  }
  const sig = Buffer.from(s.sig, "base64");
  const pub = leaf.publicKey;
  let good = false;
  try {
    good = verify(pub.asymmetricKeyType === "ed25519" ? null : "sha256", message, pub, sig);
  } catch {
    good = false;
  }
  if (!good) return { ok: false, reason: "the signature does not verify against its certificate's key" };
  if (!usableFor(leaf, OID.codeSigning)) return { ok: false, reason: "the certificate was not issued for code signing" };
  const issuer = certificateIssuer(leaf);
  const subjects = certificateSubjects(leaf);
  const said = `${issuer ?? "no issuer"} ${subjects.join(" ") || "no subject"}`;
  const named = identities.filter((i) => i.issuer === issuer && subjects.some((s2) => subjectPattern(i.subject).test(s2)));
  if (named.length === 0) return { ok: false, reason: `the certificate's identity (${said}) is not one the policy at base lists under keyless.identities` };
  const problems: string[] = [];
  for (const id of named) {
    let at: Date;
    try {
      at = verifyTimestamp(Buffer.from(s.timestamp, "base64"), sig, id.roots);
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err));
      continue;
    }
    if (!chainsTo(leaf, chain, id.roots.ca, at)) {
      problems.push(`the certificate does not chain to a certificate authority of the trusted root, valid at ${at.toISOString()}`);
      continue;
    }
    const subject = subjects.find((s2) => subjectPattern(id.subject).test(s2))!;
    return { ok: true, principal: id.principal, keyid: certificateKeyid(leaf), issuer: issuer!, subject, signedAt: at.toISOString() };
  }
  return { ok: false, reason: `the keyless signature by ${said} does not verify: ${[...new Set(problems)].join("; ")}` };
}

// ── Sign ─────────────────────────────────────────────────────────────────────

/** The default certificate authority and timestamp authority: sigstore's public-good instances. */
export const DEFAULT_FULCIO_URL = "https://fulcio.sigstore.dev";
export const DEFAULT_TIMESTAMP_URL = "https://timestamp.sigstore.dev/api/v1/timestamp";
/** The audience the job's token is requested for, as Fulcio expects. */
export const DEFAULT_SIGNING_AUDIENCE = "sigstore";

export { SIGNING_ID_TOKEN_VAR };

/**
 * The job's OIDC token for `audience`: GitLab's {@link SIGNING_ID_TOKEN_VAR},
 * else the token request URL GitHub serves a job with `id-token: write`
 * (and Forgejo 15 a job with `enable-openid-connect: true`), as the cloud
 * login of ../../ci-login.ts takes it.
 */
export async function signingToken(env: NodeJS.ProcessEnv, audience: string, fetchFn: typeof fetch): Promise<string> {
  const given = env[SIGNING_ID_TOKEN_VAR];
  if (given) return given.trim();
  const url = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !bearer) {
    throw new Error(
      `the job has no OIDC token to sign with: GitLab needs id_tokens: ${SIGNING_ID_TOKEN_VAR}: aud: ${audience}; GitHub needs permissions: id-token: write; Forgejo 15 needs enable-openid-connect: true`,
    );
  }
  const r = await fetchFn(`${url}${url.includes("?") ? "&" : "?"}audience=${encodeURIComponent(audience)}`, { headers: { authorization: `bearer ${bearer}`, accept: "application/json" } });
  if (!r.ok) throw new Error(`the OIDC token request answered ${r.status}`);
  const value = ((await r.json()) as { value?: unknown }).value;
  if (typeof value !== "string" || !value) throw new Error("the OIDC token request answered no token");
  return value;
}

/** A JWT's claims, read without verifying: the certificate authority verifies the token. */
export function tokenClaims(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) throw new Error("the OIDC token is not a JWT");
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

const pemToDer = (pem: string): Buffer => Buffer.from(pem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, ""), "base64");

/** A signing certificate: the run's own key, and the chain Fulcio issued for it. */
export interface KeylessCertificate {
  key: KeyObject;
  /** Base64 DER, the signing certificate first. */
  certificates: string[];
}

/**
 * Trade `token` for a certificate over a P-256 key made for this run, at
 * Fulcio's `POST /api/v2/signingCert`. The proof of possession is the
 * token's subject signed with that key.
 */
export async function requestCertificate(token: string, fulcioUrl: string, fetchFn: typeof fetch): Promise<KeylessCertificate> {
  const sub = tokenClaims(token).sub;
  if (typeof sub !== "string" || !sub) throw new Error("the OIDC token has no subject");
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const body = {
    credentials: { oidcIdentityToken: token },
    publicKeyRequest: {
      publicKey: { algorithm: "ECDSA", content: publicKey.export({ format: "pem", type: "spki" }).toString() },
      proofOfPossession: sign("sha256", Buffer.from(sub, "utf8"), privateKey).toString("base64"),
    },
  };
  const r = await fetchFn(`${fulcioUrl.replace(/\/+$/, "")}/api/v2/signingCert`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`the certificate authority at ${fulcioUrl} answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const doc = (await r.json()) as Record<string, { chain?: { certificates?: unknown } } | undefined>;
  const pems = (doc.signedCertificateEmbeddedSct ?? doc.signedCertificateDetachedSct)?.chain?.certificates;
  if (!Array.isArray(pems) || pems.length === 0 || !pems.every((p) => typeof p === "string")) throw new Error(`the certificate authority at ${fulcioUrl} answered no certificate chain`);
  const certificates = (pems as string[]).map((p) => pemToDer(p).toString("base64"));
  const leaf = new X509Certificate(Buffer.from(certificates[0]!, "base64"));
  const spki = (k: KeyObject) => k.export({ format: "der", type: "spki" }) as Buffer;
  if (!spki(leaf.publicKey).equals(spki(createPublicKey(privateKey)))) throw new Error("the certificate authority certified another key");
  return { key: privateKey, certificates };
}

/** An RFC 3161 TimeStampReq for the SHA-256 of `data`, asking for the authority's certificate. */
export function timestampRequest(data: Buffer): Buffer {
  const digest = createHash("sha256").update(data).digest();
  return der(DER.SEQUENCE, derInt(1), der(DER.SEQUENCE, der(DER.SEQUENCE, derOid(OID.sha256), der(DER.NULL)), der(DER.OCTET_STRING, digest)), derInt(BigInt(`0x${createHash("sha256").update(digest).update(String(Date.now())).digest("hex").slice(0, 15)}`)), der(DER.BOOLEAN, Buffer.from([0xff])));
}

/** The TimeStampToken from a TimeStampResp. */
function tokenOfResponse(resp: Buffer): Buffer {
  const parts = derChildren(derRead(resp));
  const status = parts[0] ? derChildren(parts[0])[0] : undefined;
  if (!status || status.value.readUIntBE(0, status.value.length) > 1 || !parts[1]) throw new Error("the timestamp authority did not grant the timestamp");
  return Buffer.from(parts[1].raw);
}

/** A timestamp token over `signature` from the authority at `url`. */
export async function requestTimestamp(signature: Buffer, url: string, fetchFn: typeof fetch): Promise<Buffer> {
  const r = await fetchFn(url, { method: "POST", headers: { "content-type": "application/timestamp-query", accept: "application/timestamp-reply" }, body: new Uint8Array(timestampRequest(signature)) });
  if (!r.ok) throw new Error(`the timestamp authority at ${url} answered ${r.status}`);
  return tokenOfResponse(Buffer.from(await r.arrayBuffer()));
}

/** Sign `message` (an envelope's PAE) with `cert`'s key and have the signature timestamped. */
export async function keylessSignature(message: Buffer, cert: KeylessCertificate, timestampUrl: string, fetchFn: typeof fetch): Promise<KeylessSignature> {
  const sig = sign("sha256", message, cert.key);
  const timestamp = await requestTimestamp(sig, timestampUrl, fetchFn);
  return { keyid: certificateKeyid(new X509Certificate(Buffer.from(cert.certificates[0]!, "base64"))), sig: sig.toString("base64"), certificates: cert.certificates, timestamp: timestamp.toString("base64") };
}
