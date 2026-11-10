/**
 * #3763: the zod-free check of `.chant/trust.json` accepts exactly what the
 * trust policy's zod schema accepts, so a bundled reader turns attestation
 * off for the same files chant does.
 */

import { describe, expect, test } from "vitest";
import { trustConfigSchema } from "./policy";
import { trustConfigProblems } from "./trust-files";

const commit = "a".repeat(40);
const ed = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOv1";

const cases: Array<[string, unknown]> = [
  ["the smallest", { schema: 1 }],
  ["everything", {
    schema: 1,
    signers: "ops/allowed_signers",
    roles: { admin: ["alice"], "release-1": ["bob", "carol"] },
    adopted: [{ to: commit }, { from: commit, to: "b".repeat(64), note: "import" }],
    runners: [{ principal: "ci", class: "runner", key: ed }],
    admitted: [{ return: "ret-0123456789ab", signers: [{ principal: "dana", key: "ssh-rsa AAAAB3Nza==" }], note: "n" }],
    passkeys: [{ principal: "github:erin", id: "cred-1_x", publicKey: "MCowBQYDK2VwAyEA", rpId: "example.com", origins: ["https://example.com"] }],
    refs: [{ ref: "refs/heads/main", checks: [{ check: "plan", action: "block", command: "chant ci run plan" }, { check: "lint", command: "npm run lint" }], status: "chant/ref-gate", overrides: "ledger" }],
  }],
  ["local evidence", { schema: 1, local: { keys: [{ principal: "alice", class: "person", key: ed }, { principal: "agent:s1", class: "agent", key: ed }], checks: [{ check: "fmt" }, { check: "lint", from: ["person", "agent"] }] } }],
  ["an empty local", { schema: 1, local: {} }],
  ["local evidence for plan", { schema: 1, local: { checks: [{ check: "plan" }] } }],
  ["local evidence for a wave's policy", { schema: 1, local: { checks: [{ check: "policy:wave-1" }] } }],
  ["local evidence for apply", { schema: 1, local: { checks: [{ check: "apply" }] } }],
  ["local evidence for drift", { schema: 1, local: { checks: [{ check: "drift" }] } }],
  ["a local key of a runner's class", { schema: 1, local: { keys: [{ principal: "ci", class: "runner", key: ed }] } }],
  ["local evidence from nobody", { schema: 1, local: { checks: [{ check: "fmt", from: [] }] } }],
  ["local with an extra key", { schema: 1, local: { checks: [], skip: true } }],
  ["keyless identities", { schema: 1, keyless: { trustedRoot: ".chant/trusted_root.json", since: commit, fulcio: "https://fulcio.example", timestamp: "https://tsa.example/ts", audience: "sigstore", identities: [{ principal: "ci", class: "runner", issuer: "https://token.actions.githubusercontent.com", subject: "https://github.com/acme/infra/.github/workflows/*@refs/heads/main" }] } }],
  ["keyless with no identities", { schema: 1, keyless: { trustedRoot: ".chant/trusted_root.json", identities: [] } }],
  ["keyless with no trusted root", { schema: 1, keyless: { identities: [{ principal: "ci", class: "runner", issuer: "https://x.example", subject: "s" }] } }],
  ["a keyless identity whose issuer is not a URL", { schema: 1, keyless: { trustedRoot: "r.json", identities: [{ principal: "ci", class: "runner", issuer: "github", subject: "s" }] } }],
  ["a keyless identity with a key", { schema: 1, keyless: { trustedRoot: "r.json", identities: [{ principal: "ci", class: "runner", issuer: "https://x.example", subject: "s", key: ed }] } }],
  ["a short keyless since", { schema: 1, keyless: { trustedRoot: "r.json", since: "abc", identities: [{ principal: "ci", class: "runner", issuer: "https://x.example", subject: "s" }] } }],
  ["a ref rule with no checks", { schema: 1, refs: [{ ref: "refs/heads/main", checks: [] }] }],
  ["a ref rule on a short ref name", { schema: 1, refs: [{ ref: "main", checks: [{ check: "plan", command: "x" }] }] }],
  ["a ref check with no command", { schema: 1, refs: [{ ref: "refs/heads/main", checks: [{ check: "plan" }] }] }],
  ["a ref check with another action", { schema: 1, refs: [{ ref: "refs/heads/main", checks: [{ check: "plan", action: "deny", command: "x" }] }] }],
  ["a ref check name with a slash", { schema: 1, refs: [{ ref: "refs/heads/main", checks: [{ check: "a/b", command: "x" }] }] }],
  ["a ref rule with an extra key", { schema: 1, refs: [{ ref: "refs/heads/main", checks: [{ check: "plan", command: "x" }], extra: 1 }] }],
  ["a passkey with no origins", { schema: 1, passkeys: [{ principal: "e", id: "c", publicKey: "k", rpId: "example.com", origins: [] }] }],
  ["a passkey whose key is padded base64", { schema: 1, passkeys: [{ principal: "e", id: "c", publicKey: "k+/=", rpId: "example.com", origins: ["https://example.com"] }] }],
  ["a passkey with an extra key", { schema: 1, passkeys: [{ principal: "e", id: "c", publicKey: "k", rpId: "example.com", origins: ["https://example.com"], alg: -8 }] }],
  ["a passkey with no rpId", { schema: 1, passkeys: [{ principal: "e", id: "c", publicKey: "k", origins: ["https://example.com"] }] }],
  ["schema 2", { schema: 2 }],
  ["no schema", {}],
  ["not an object", [1]],
  ["null", null],
  ["an unknown key", { schema: 1, extra: true }],
  ["an absolute signers path", { schema: 1, signers: "/etc/signers" }],
  ["a signers path with ..", { schema: 1, signers: "a/../b" }],
  ["a signers path that is not normal", { schema: 1, signers: "./a" }],
  ["a signers path with a backslash", { schema: 1, signers: "a\\b" }],
  ["an empty signers path", { schema: 1, signers: "" }],
  ["a role name with capitals", { schema: 1, roles: { Admin: ["a"] } }],
  ["a role with an empty principal", { schema: 1, roles: { admin: [""] } }],
  ["roles as a list", { schema: 1, roles: [] }],
  ["a short adopted commit", { schema: 1, adopted: [{ to: "abc" }] }],
  ["an adopted range with an extra key", { schema: 1, adopted: [{ to: commit, by: "x" }] }],
  ["a runner with an rsa key", { schema: 1, runners: [{ principal: "ci", class: "runner", key: "ssh-rsa AAAA" }] }],
  ["a runner of another class", { schema: 1, runners: [{ principal: "ci", class: "human", key: ed }] }],
  ["an admission with no signers", { schema: 1, admitted: [{ return: "ret-0123456789ab", signers: [] }] }],
  ["an admission with a bad id", { schema: 1, admitted: [{ return: "ret-1", signers: [{ principal: "d", key: ed }] }] }],
  ["an admitted key with a comment", { schema: 1, admitted: [{ return: "ret-0123456789ab", signers: [{ principal: "d", key: `${ed} dana@laptop` }] }] }],
];

describe("trustConfigProblems", () => {
  test.each(cases)("agrees with the zod schema: %s", (_name, raw) => {
    expect(trustConfigProblems(raw).length === 0).toBe(trustConfigSchema.safeParse(raw).success);
  });
});
