/**
 * TF008: a `provider` block configures a credential inline.
 *
 * The most corroborated rule in #2107's survey: checkov (`CKV_AWS_41` and its
 * `credentials.py` siblings), KICS, Snyk and semgrep all ship a version of it,
 * and it is the only Terraform-language-shaped check any of Snyk or semgrep
 * ships at all. Every one of them is written per provider. This one is written
 * against attribute NAMES, so it covers the providers those tools cover and
 * the several hundred they do not.
 *
 * A credential in a provider block is used by every resource that provider
 * manages, so it is the highest-value one in the root, and it is read from the
 * repository by everyone who can clone it. Providers all accept the same
 * credential through the environment or a shared config file instead.
 *
 * Scope: root and child modules alike (#2112). The condition is a property
 * of the block itself, so a descended module's block is read exactly as a
 * root's is.
 */

import type {
  PostSynthCheck,
  PostSynthContext,
  PostSynthDiagnostic,
} from "@intentius/chant/lint/post-synth";
import { PROVIDER_TYPE } from "../../hcl/parse";
import { isLiteralString, isPlaceholderValue, isSecretName } from "../secret-shape";
import { blockName, blocksOfType, walkAttributes } from "./blocks";

/**
 * Credential attributes the name heuristic in `../secret-shape.ts` does not
 * cover on its own. `client_secret` and the `*_key`/`*_token` names it does
 * cover are not repeated here.
 */
const PROVIDER_CREDENTIAL_ATTRS = new Set(["credentials", "client_certificate", "client_key", "shared_credentials_file"]);

/**
 * A path, not a credential: `credentials = "keys/service-account.json"` and
 * `shared_credentials_file = "~/.aws/credentials"` name where the secret lives,
 * which is what the fix looks like.
 */
const FILE_PATH_RE = /^[~./]?[\w./\\-]*\.(json|pem|key|p12|pfx|crt|cer|ini|conf|credentials)$/i;

export const tf008: PostSynthCheck = {
  id: "TF008",
  description: "Provider block configures a hardcoded credential",

  check(ctx: PostSynthContext): PostSynthDiagnostic[] {
    const diagnostics: PostSynthDiagnostic[] = [];

    for (const block of blocksOfType(ctx, PROVIDER_TYPE)) {
      for (const attr of walkAttributes(block.body)) {
        if (!PROVIDER_CREDENTIAL_ATTRS.has(attr.name) && !isSecretName(attr.name)) continue;
        if (!isLiteralString(attr.value)) continue;
        const value = attr.value.trim();
        if (value === "" || isPlaceholderValue(value) || FILE_PATH_RE.test(value)) continue;

        diagnostics.push({
          checkId: "TF008",
          severity: "error",
          message:
            `Provider "${blockName(block.address)}" sets \`${attr.path}\` to a literal value ` +
            `(${value.length} characters, redacted here). A credential in a provider block is ` +
            "committed to the repository and used by every resource the provider manages. Remove it " +
            "and let the provider read the credential from the environment, a shared config file, or " +
            "a sensitive variable.",
          entity: `${block.key}.${attr.path}`,
          lexicon: "terraform",
        });
      }
    }

    return diagnostics;
  },
};
