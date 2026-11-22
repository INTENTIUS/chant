/**
 * The shape of `release.signing` in `chant.config.ts` (#5164, #5458), kept
 * apart from ./publish-signing.ts so the config schema can check it without
 * loading the publish.
 */
import { z } from "zod";

/**
 * `release.signing` in `chant.config.ts` (#5164, #5458): `true`, `false`, or
 * an object whose keys pick the mode. With no `key` it signs
 * keylessly with the CI job's OIDC token, and `identity` and `issuer` name
 * what a verify expects. With `key` it signs with a cosign key: a file from
 * the member, or `env://NAME`, a variable holding the PEM, whose password is
 * in `passwordEnv` (default `COSIGN_PASSWORD`); `publicKey` is the PEM a
 * verify checks against. `rekor: false` writes no transparency log entry.
 */
export type SigningConfig =
  | boolean
  | {
      identity?: string;
      issuer?: string;
      key?: string;
      passwordEnv?: string;
      publicKey?: string;
      rekor?: false;
    };

/**
 * What is wrong with `release.signing`, each in a sentence (#5458): the mode
 * keys mixed, or a key without what verifies it. The config schema refuses
 * a config with any.
 */
export function signingConfigProblems(c: Exclude<SigningConfig, boolean>): string[] {
  const out: string[] = [];
  const keyed = c.key !== undefined;
  if (keyed && (c.identity !== undefined || c.issuer !== undefined)) out.push("identity and issuer name a keyless certificate, and key signs with no certificate");
  if (keyed && c.publicKey === undefined) out.push("key needs publicKey, the PEM public key release verify checks the signatures against");
  if (!keyed && c.passwordEnv !== undefined) out.push("passwordEnv is the password of a key, and no key is named");
  if (!keyed && c.publicKey !== undefined) out.push("publicKey verifies a key's signatures, and no key is named");
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
