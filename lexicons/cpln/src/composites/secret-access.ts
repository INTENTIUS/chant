/**
 * SecretAccess — the identity and policy a workload needs to read a secret.
 *
 * Control Plane's own documentation calls a partial version of this its number
 * one support issue: reading a secret at runtime takes three separate steps,
 * and **missing any one of them fails silently at runtime** rather than at
 * apply time.
 *
 *   1. An identity exists, and the workload's `spec.identityLink` points at it.
 *   2. A policy grants that identity `reveal` on the secret, with the identity
 *      named as a principal in a binding.
 *   3. The workload references the secret in the field-qualified form —
 *      `cpln://secret/NAME.payload`, not `cpln://secret/NAME`.
 *
 * This composite owns steps 1 and 2, and {@link secretRef} exists for step 3 so
 * the field qualifier is hard to forget.
 *
 * The principal link is the part most worth automating. A binding written
 * against `//identity/NAME` — which reads perfectly naturally, and is what
 * you would guess — is accepted by the API and then **silently ignored**. Only
 * the GVC-qualified `//gvc/GVC/identity/NAME` form works. This composite only
 * emits the qualified form.
 */

import { Composite, mergeDefaults } from "@intentius/chant";
import { Identity, Policy } from "../generated";

export interface SecretAccessProps {
  /** Identity name. The policy is named `<name>-secret-access` unless overridden. */
  name: string;
  /** GVC the identity lives in. Identities cannot be shared across GVCs. */
  gvc: string;
  /**
   * Names of the org-scoped secrets this identity may read. Each becomes a
   * `//secret/NAME` target link on the policy.
   */
  secrets: string[];
  /** Policy name (default `<name>-secret-access`). */
  policyName?: string;
  /**
   * Permissions granted on the target secrets (default `["reveal"]`).
   * Control Plane requires the list to be sorted and unique, which this does.
   */
  permissions?: string[];
  /** Tags applied to both resources. */
  tags?: Record<string, string>;
  /** Per-member defaults for customizing individual resources. */
  defaults?: {
    identity?: Partial<ConstructorParameters<typeof Identity>[0]>;
    policy?: Partial<ConstructorParameters<typeof Policy>[0]>;
  };
}

export const SecretAccess = Composite((props: SecretAccessProps) => {
  const {
    name,
    gvc,
    secrets,
    policyName = `${name}-secret-access`,
    permissions = ["reveal"],
    tags,
    defaults: defs,
  } = props;

  if (secrets.length === 0) {
    throw new Error(
      `SecretAccess "${name}": no secrets listed. A policy with no target links grants nothing, ` +
        `and the workload would fail to read its secrets at runtime with no apply-time error.`,
    );
  }

  const identity = new Identity(
    mergeDefaults(
      {
        name,
        gvc,
        ...(tags && { tags }),
      } as Record<string, unknown>,
      defs?.identity,
    ),
  );

  const policy = new Policy(
    mergeDefaults(
      {
        name: policyName,
        ...(tags && { tags }),
        targetKind: "secret",
        targetLinks: [...secrets].sort().map((secret) => `//secret/${secret}`),
        bindings: [
          {
            // Sorted and deduplicated: Control Plane requires permissions in a
            // binding to be both.
            permissions: [...new Set(permissions)].sort(),
            // The GVC-qualified form. The bare `//identity/NAME` is silently
            // ignored — see the module comment.
            principalLinks: [identityLink(gvc, name)],
          },
        ],
      } as Record<string, unknown>,
      defs?.policy,
    ),
  );

  return { identity, policy };
}, "SecretAccess");

/**
 * The GVC-qualified principal link for an identity.
 *
 * Exported because this is the form policies must use, and the unqualified one
 * fails silently.
 */
export function identityLink(gvc: string, name: string): string {
  return `//gvc/${gvc}/identity/${name}`;
}

/**
 * A field-qualified secret reference for use in a container's env or volumes.
 *
 * The field name is required. `cpln://secret/db.password` resolves; the
 * unqualified `cpln://secret/db` does not, except for `gcp` secrets mounted as
 * a file. The field differs by secret type:
 *
 * | Type | Field |
 * |---|---|
 * | `opaque` | `payload` |
 * | `dictionary` | any key |
 * | `userpass` | `username`, `password` |
 * | `tls` | `cert`, `key` |
 * | `keypair` | `publicKey`, `privateKey` |
 * | `aws` | `accessKey`, `secretKey`, `roleArn` |
 */
export function secretRef(name: string, field: string): string {
  return `cpln://secret/${name}.${field}`;
}
