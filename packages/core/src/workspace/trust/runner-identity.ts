/**
 * The runner identity an init writes into `.chant/trust.json` (#4869).
 *
 * None of the CI products' inits wrote `.chant/trust.json`, a runner key
 * or an identity, so a keyless runner had nowhere to come from. These are
 * the pieces an init calls: {@link ciRunnerIdentity} names the identity the
 * generated workflow signs as, on the forge it runs on, and
 * {@link withRunnerIdentity} adds it to the file's text under `keyless`,
 * with the principal in `roles.runner`, which ci tags and Op runs need.
 *
 * The subject is the certificate's subject alternative name the
 * certificate authority writes for that job: on GitHub the workflow file at
 * a ref (`https://github.com/<owner>/<repo>/<workflow path>@<ref>`), on
 * GitLab the CI config at a ref (`<server>/<project>//<config path>@<ref>`).
 * A Forgejo job's certificate comes from a private authority, whose
 * issuer and subject the project names itself.
 */

import { trustConfigSchema, type TrustConfig } from "./policy";

/** The trusted root an init points `keyless.trustedRoot` at, unless told. */
export const DEFAULT_TRUSTED_ROOT_PATH = ".chant/trusted_root.json";

/** One entry of `keyless.identities`. */
export interface KeylessIdentityEntry {
  principal: string;
  class: "runner" | "service";
  issuer: string;
  subject: string;
}

export interface CiRunnerIdentityInput {
  forge: "github" | "gitlab" | "forgejo";
  /** `owner/repo` on GitHub and Forgejo, the project path on GitLab. */
  repository: string;
  /** The workflow file (GitHub, Forgejo), such as `.github/workflows/chant-pr.yml`, or the CI config path (GitLab, default `.gitlab-ci.yml`). A `*` matches within the file name. */
  workflow?: string;
  /** The ref the job runs at. Default `refs/heads/main`. A pull request job runs at another ref, such as `refs/pull/*\/merge`. */
  ref?: string;
  /** The forge's URL. Default `https://github.com` or `https://gitlab.com`; required on Forgejo. */
  server?: string;
  /** The OIDC issuer. Default GitHub's or the GitLab server; required on Forgejo. */
  issuer?: string;
  /** The subject pattern, instead of the one the forge's job would have. Required on Forgejo. */
  subject?: string;
  /** Default `ci`. */
  principal?: string;
}

const trim = (u: string): string => u.replace(/\/+$/, "");

/** The `keyless.identities` entry for the generated workflow's jobs on `forge`. Throws when the forge's identity cannot be worked out. */
export function ciRunnerIdentity(input: CiRunnerIdentityInput): KeylessIdentityEntry {
  const ref = input.ref ?? "refs/heads/main";
  const principal = input.principal ?? "ci";
  if (!/^[^\s/][^\s]*\/[^\s]+$/.test(input.repository)) throw new Error(`repository ${JSON.stringify(input.repository)} is not an owner/name path`);
  if (input.forge === "github") {
    if (!input.workflow) throw new Error("a GitHub runner identity names its workflow file, such as .github/workflows/chant-pr.yml");
    const server = trim(input.server ?? "https://github.com");
    return { principal, class: "runner", issuer: input.issuer ?? "https://token.actions.githubusercontent.com", subject: input.subject ?? `${server}/${input.repository}/${input.workflow}@${ref}` };
  }
  if (input.forge === "gitlab") {
    const server = trim(input.server ?? "https://gitlab.com");
    return { principal, class: "runner", issuer: input.issuer ?? server, subject: input.subject ?? `${server}/${input.repository}//${input.workflow ?? ".gitlab-ci.yml"}@${ref}` };
  }
  if (!input.issuer || !input.subject) {
    throw new Error("a Forgejo job's certificate comes from the certificate authority the project runs, so its runner identity names that authority's issuer and the subject it writes");
  }
  return { principal, class: "runner", issuer: input.issuer, subject: input.subject };
}

/**
 * `.chant/trust.json`'s text (or none, for a new file) with `identity` under
 * `keyless.identities` and its principal in `roles.runner`. An identity
 * with the same issuer and subject is not added twice. `trustedRoot` is
 * written when the file sets none. Throws when the result is not a valid
 * trust config.
 */
export function withRunnerIdentity(text: string | undefined, identity: KeylessIdentityEntry, opts: { trustedRoot?: string } = {}): string {
  const config: TrustConfig = text === undefined || text.trim() === "" ? { schema: 1 } : (JSON.parse(text) as TrustConfig);
  const keyless = config.keyless ?? { trustedRoot: opts.trustedRoot ?? DEFAULT_TRUSTED_ROOT_PATH, identities: [] };
  if (!keyless.identities.some((i) => i.issuer === identity.issuer && i.subject === identity.subject)) keyless.identities = [...keyless.identities, identity];
  const runners = config.roles?.runner ?? [];
  const next: TrustConfig = {
    ...config,
    roles: { ...(config.roles ?? {}), runner: runners.includes(identity.principal) ? runners : [...runners, identity.principal] },
    keyless,
  };
  const parsed = trustConfigSchema.safeParse(next);
  if (!parsed.success) throw new Error(`the trust config with the runner identity is invalid: ${parsed.error.issues.map((i) => `${i.path.join(".") || "/"}: ${i.message}`).join("; ")}`);
  return `${JSON.stringify(next, null, 2)}\n`;
}
