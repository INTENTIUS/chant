/**
 * What a pending gate fact is written with, apart from the ledger's git code
 * (#3816): its default expiry and the address of its approval surface. A
 * bundle that records a pending fact through its own port, such as
 * `@intentius/chant/point-decision`, imports these without git.
 * `./gate-ledger.ts` re-exports them.
 */

/** The default a gate's pending fact expires after when its `GateStep` declares no `timeout` — the same 48h `GateStep.timeout` documents as its own default. */
export const DEFAULT_GATE_EXPIRY = "48h";

/**
 * The address of the approval surface for a gate, resolved from the CI
 * environment (#2028).
 *
 * #1485's argument for gate-as-fact was that approval gets an address:
 * "gate-as-PR gives approval a URL, a review surface, and CODEOWNERS as the
 * authorization model." What shipped recorded the gate and not the address,
 * so a pending-approval card had nothing to link to and gate-as-PR stayed a
 * convention. This is the narrow, honest half of that: when a tick (or a
 * `chant approve`) runs inside the PR/MR job that carries the change, the
 * loop genuinely knows where approval happens, and says so. Anywhere else it
 * returns `undefined` and the field is simply absent — never a guess, never a
 * synthesized link.
 *
 * The env-var fallback chain is the same one `--actor` and `--run-id` already
 * use (`../cli/handlers/components.ts`): GitHub Actions first, then GitLab CI.
 *
 * - GitHub Actions on a `pull_request` event: `GITHUB_SERVER_URL` +
 *   `GITHUB_REPOSITORY` + the PR number, which `GITHUB_REF_NAME` carries as
 *   `<n>/merge`. A push-event run has no PR, so it resolves to nothing.
 * - GitLab CI on a merge-request pipeline: `CI_MERGE_REQUEST_PROJECT_URL` +
 *   `CI_MERGE_REQUEST_IID`.
 */
export function resolveApprovalUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const prNumber = /^(\d+)\/(merge|head)$/.exec(env.GITHUB_REF_NAME ?? "")?.[1];
  if (prNumber && env.GITHUB_REPOSITORY) {
    const server = (env.GITHUB_SERVER_URL ?? "https://github.com").replace(/\/$/, "");
    return `${server}/${env.GITHUB_REPOSITORY}/pull/${prNumber}`;
  }

  if (env.CI_MERGE_REQUEST_PROJECT_URL && env.CI_MERGE_REQUEST_IID) {
    return `${env.CI_MERGE_REQUEST_PROJECT_URL.replace(/\/$/, "")}/-/merge_requests/${env.CI_MERGE_REQUEST_IID}`;
  }

  return undefined;
}

/**
 * Whether `raw` is an address worth recording as one: an absolute `http`/
 * `https` URL. A gate's address is a link a reader is expected to follow, so
 * a relative path or a `file:`/`javascript:` scheme is refused at the CLI
 * boundary rather than written into an immutable record.
 */
export function isApprovalUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
