/**
 * The shape of `release.signing` in `chant.config.ts` (#5164, #5458), kept
 * apart from ./publish-signing.ts so the config schema can check it without
 * loading the publish.
 */
import { z } from "zod";

/**
 * `release.signing` in `chant.config.ts` (#5164, #5458): `true`, `false`, or
 * an object whose keys pick the mode. With neither `kms` nor `key` it signs
 * keylessly with the CI job's OIDC token, and `identity` and `issuer` name
 * what a verify expects. With `kms` it signs with a key held in a KMS, named
 * by a cosign KMS reference (`awskms://`, `gcpkms://`, `azurekms://`,
 * `hashivault://`), with the credentials in the variables `env` names
 * (default {@link KMS_DEFAULT_ENV}). With `key` it signs with a cosign key: a
 * file from the member, or `env://NAME`, a variable holding the PEM, whose
 * password is in `passwordEnv` (default `COSIGN_PASSWORD`). `publicKey` is
 * the PEM a verify checks against: required with `key`, and with `kms` in
 * place of asking the KMS. `rekor: false` writes no transparency log entry.
 */
export type SigningConfig =
  | boolean
  | {
      identity?: string;
      issuer?: string;
      kms?: string;
      env?: string[];
      key?: string;
      passwordEnv?: string;
      publicKey?: string;
      rekor?: false;
    };

/** The KMS schemes cosign takes a key reference in. */
export const KMS_SCHEMES = ["awskms", "gcpkms", "azurekms", "hashivault"] as const;
export type KmsScheme = (typeof KMS_SCHEMES)[number];

/**
 * The variables a KMS's credentials are read from when `release.signing.env`
 * names none (#5458). Google Cloud's client reads a credentials file, or the
 * runner's own identity, so it has no default and its config names them.
 */
export const KMS_DEFAULT_ENV: Record<KmsScheme, string[]> = {
  awskms: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"],
  gcpkms: [],
  azurekms: ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"],
  hashivault: ["VAULT_ADDR", "VAULT_TOKEN"],
};

/** The scheme of a KMS reference, or null when it is not one cosign takes. */
export function kmsSchemeOf(ref: string): KmsScheme | null {
  const m = /^([a-z]+):\/\/./.exec(ref);
  return m && (KMS_SCHEMES as readonly string[]).includes(m[1]!) ? (m[1] as KmsScheme) : null;
}

/** The variables that hold a KMS reference's credentials: `env`, else the scheme's default. */
export function kmsEnvOf(kms: string, env: readonly string[] | undefined): string[] {
  if (env) return [...env];
  const scheme = kmsSchemeOf(kms);
  return scheme ? KMS_DEFAULT_ENV[scheme] : [];
}

/**
 * What is wrong with `release.signing`, each in a sentence (#5458): the mode
 * keys mixed, a KMS reference cosign does not take, or a key without what
 * verifies it. The config schema refuses a config with any.
 */
export function signingConfigProblems(c: Exclude<SigningConfig, boolean>): string[] {
  const out: string[] = [];
  const keyed = c.key !== undefined || c.kms !== undefined;
  const mode = c.kms !== undefined ? "kms" : "key";
  if (c.key !== undefined && c.kms !== undefined) out.push("kms and key are two ways to sign; name one");
  if (keyed && (c.identity !== undefined || c.issuer !== undefined)) out.push(`identity and issuer name a keyless certificate, and ${mode} signs with no certificate`);
  if (c.key !== undefined && c.publicKey === undefined) out.push("key needs publicKey, the PEM public key release verify checks the signatures against");
  if (c.kms !== undefined && kmsSchemeOf(c.kms) === null) out.push(`kms ${JSON.stringify(c.kms)} is not a reference cosign takes: ${KMS_SCHEMES.map((k) => `${k}://`).join(", ")}`);
  if (c.kms === undefined && c.env !== undefined) out.push("env names a KMS's credentials, and no kms is named");
  if (c.key === undefined && c.passwordEnv !== undefined) out.push("passwordEnv is the password of a key, and no key is named");
  if (!keyed && c.publicKey !== undefined) out.push("publicKey verifies a key's signatures, and no key or kms is named");
  if (!keyed && c.rekor === false) out.push("rekor: false leaves the transparency log out, and a keyless signature needs it");
  if (c.key !== undefined && c.key.startsWith("env://") && !/^env:\/\/[A-Za-z_][A-Za-z0-9_]*$/.test(c.key)) out.push(`key ${JSON.stringify(c.key)} is not env://NAME`);
  return out;
}

/** The variable an `env://NAME` key reads, or null for a key file. */
export function keyEnvOf(key: string): string | null {
  return key.startsWith("env://") ? key.slice("env://".length) : null;
}

/** The schema `release.signing` is read with: the keys of every mode, then {@link signingConfigProblems}. */
export const SigningConfigSchema = z.union([
  z.boolean(),
  z
    .object({
      identity: z.string().min(1).optional(),
      issuer: z.string().min(1).optional(),
      kms: z.string().min(1).optional(),
      env: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "a variable name")).optional(),
      key: z.string().min(1).optional(),
      passwordEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "a variable name").optional(),
      publicKey: z.string().min(1).optional(),
      rekor: z.literal(false).optional(),
    })
    .strict()
    .superRefine((c, ctx) => {
      for (const message of signingConfigProblems(c)) ctx.addIssue({ code: "custom", message });
    }),
]);
