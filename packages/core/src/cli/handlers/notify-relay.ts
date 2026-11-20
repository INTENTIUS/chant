/**
 * `chant notify relay` (#4611): serve the relay that turns a chat click into
 * a `chant approve` (../../notify-relay.ts), from a checkout of the repo.
 *
 * ```
 * CHANT_RELAY_KEY=... SLACK_SIGNING_SECRET=... chant notify relay
 * ```
 *
 * Settings come from the environment (`RELAY_ENV`), as a container or
 * function host sets them: the relay key, the Slack signing secret, the
 * Teams HMAC key, the relay's principal (default `<product>-relay`), the
 * maximum age of a button (default a day), and the host and port (default
 * 127.0.0.1:8787). The relay refuses to start with neither chat secret, or
 * with no relay key, since it could then verify nothing.
 *
 * Each click fetches the default branch and `chant/lifecycle`, reads the
 * signers file at the default branch's tip, and records through
 * `recordGateApproval`, one click at a time, so two clicks never race on the
 * ledger. A gate that asks a decision point gets its question answered
 * through `answerPoint` instead (#4611).
 *
 * With `--repo <url>` the relay checks its token and clones the repo itself
 * (#4759, ../../notify-relay-repo.ts):
 *
 * ```
 * chant notify relay --repo https://github.com/acme/infra.git --token-env RELAY_TOKEN --host 0.0.0.0
 * ```
 *
 * `--token-env` names the variable holding the approve-only token (default
 * `CHANT_RELAY_TOKEN`), `--forge` the forge for a host other than github.com
 * and gitlab.com, and `--host` and `--port` override `CHANT_RELAY_HOST` and
 * `CHANT_RELAY_PORT`. `CHANT_RELAY_REPO` and `CHANT_RELAY_FORGE` stand in for
 * the flags.
 *
 * Alerts (#5329) are on when `CHANT_ALERT_SECRET` or a source's own
 * `CHANT_ALERT_SECRET_<SOURCE>` is set. Each delivery's facts are written
 * and pushed one at a time with the clicks. With `--repo` and
 * `CHANT_ALERT_DISPATCH_TOKEN`, the relay starts the alert agent's workflow
 * (`CHANT_ALERT_WORKFLOW` on GitHub and Forgejo) after each new fact, and
 * refuses to start when that token can do more than start a workflow.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { activeProductWords } from "../../ci-product-words";
import { CHANT_EXIT } from "../../exit-codes";
import { DEFAULT_RELAY_MAX_AGE_SECONDS } from "../../notify";
import { alertSecretEnv, DEFAULT_RELAY_HOST, DEFAULT_RELAY_PORT, RELAY_ENV, RELAY_REPO_ENV, startRelayServer, type RelayDeps, type RelayPending, type RelaySettings } from "../../notify-relay";
import { ALERT_SOURCES, type AlertSource } from "../../ci-agent-alert";
import { formatError, formatInfo } from "../format";
import type { CommandContext } from "../registry";

/** The relay's settings, read from `env`, or the first problem with them. */
export function relaySettingsFromEnv(env: NodeJS.ProcessEnv): { settings: RelaySettings; host: string; port: number } | { error: string } {
  const key = env[RELAY_ENV.key];
  if (!key) return { error: `${RELAY_ENV.key} is not set; it holds the key notify signs the buttons with (notify.relay on the sending side)` };
  const slackSecret = env[RELAY_ENV.slackSecret] || undefined;
  const teamsSecret = env[RELAY_ENV.teamsSecret] || undefined;
  const alertSecrets: Partial<Record<AlertSource, string>> = {};
  for (const source of ALERT_SOURCES) {
    const secret = env[alertSecretEnv(source)] || env[RELAY_ENV.alertSecret] || undefined;
    if (secret) alertSecrets[source] = secret;
  }
  const alerts = Object.keys(alertSecrets).length > 0;
  if (!slackSecret && !teamsSecret && !alerts) return { error: `set ${RELAY_ENV.slackSecret}, ${RELAY_ENV.teamsSecret} or both, so the relay can verify a click, or ${RELAY_ENV.alertSecret} for alerts` };
  const alertAgeText = env[RELAY_ENV.alertMaxAge];
  const alertMaxAge = alertAgeText === undefined || alertAgeText === "" ? undefined : Number(alertAgeText);
  if (alertMaxAge !== undefined && (!Number.isInteger(alertMaxAge) || alertMaxAge <= 0)) return { error: `${RELAY_ENV.alertMaxAge} is a whole number of seconds (got ${JSON.stringify(alertAgeText)})` };
  const maxAgeText = env[RELAY_ENV.maxAge];
  const maxAge = maxAgeText === undefined || maxAgeText === "" ? DEFAULT_RELAY_MAX_AGE_SECONDS : Number(maxAgeText);
  if (!Number.isInteger(maxAge) || maxAge <= 0) return { error: `${RELAY_ENV.maxAge} is a whole number of seconds (got ${JSON.stringify(maxAgeText)})` };
  const portText = env[RELAY_ENV.port];
  const port = portText === undefined || portText === "" ? DEFAULT_RELAY_PORT : Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65535) return { error: `${RELAY_ENV.port} is a port number (got ${JSON.stringify(portText)})` };
  const slackResponse = env[RELAY_ENV.slackResponse]?.split(",").map((s) => s.trim()).filter(Boolean);
  return {
    settings: {
      key,
      ...(slackSecret ? { slackSecret } : {}),
      ...(teamsSecret ? { teamsSecret } : {}),
      maxAgeSeconds: maxAge,
      ...(slackResponse?.length ? { slackResponse } : {}),
      ...(alerts ? { alertSecrets } : {}),
      ...(alertMaxAge !== undefined ? { alertMaxAgeSeconds: alertMaxAge } : {}),
    },
    host: env[RELAY_ENV.host] || DEFAULT_RELAY_HOST,
    port,
  };
}

/** One at a time: each click's ledger read and write finish before the next starts. */
function serial(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>) => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };
}

const run = promisify(execFile);

/**
 * Fetch the default branch, the one `origin/HEAD` names, so the signers are
 * read at its current tip (#4759). A checkout with no `origin/HEAD` reads its
 * local branch as before. A fetch that fails throws: signers read from a
 * stale tip could still count one removed since.
 */
export async function fetchDefaultBranch(cwd: string): Promise<void> {
  let head: string;
  try {
    head = (await run("git", ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"], { cwd })).stdout.trim();
  } catch {
    return;
  }
  const branch = head.replace(/^refs\/remotes\/origin\//, "");
  if (!branch || branch === head) return;
  try {
    await run("git", ["fetch", "-q", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { cwd });
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new Error(`cannot fetch ${branch} to read the signers at its tip: ${(err.stderr ?? "").trim() || err.message}`);
  }
}

/** The relay's reads and writes against the checkout at `cwd`. `dispatch` starts the alert agent's workflow (#5329). */
export function checkoutRelayDeps(cwd: string, principal: string, dispatch?: RelayDeps["dispatch"]): RelayDeps {
  const words = activeProductWords();
  const one = serial();
  return {
    principal,
    words,
    ...(dispatch ? { dispatch } : {}),
    recordAlerts: (facts) =>
      one(async () => {
        const { fetchLifecycle, pushLifecycleRebasing } = await import("../../lifecycle/git");
        const { recordAgentFacts } = await import("../../agent-facts");
        await fetchLifecycle({ cwd });
        const out = await recordAgentFacts(facts, { cwd });
        // The fact must be on the remote before the workflow that reads it starts.
        if (out.recorded.length > 0) await pushLifecycleRebasing({ cwd, requireLanded: true });
        return out;
      }),
    signers: () =>
      one(async () => {
        await fetchDefaultBranch(cwd);
        const { scopeSource } = await import("../../workspace/write-scope");
        const policy = scopeSource(cwd).policy;
        return { signers: policy.signers, path: policy.signersPath, problems: policy.problems };
      }),
    pending: (digest) =>
      one(async () => {
        const { fetchLifecycle } = await import("../../lifecycle/git");
        const { pendingGatesByPlan } = await import("../../lifecycle/gate-pending-by-plan");
        const { readGateLedger } = await import("../../lifecycle/gate-ledger");
        const { latestPendingGate } = await import("../../lifecycle/gate-ledger-select");
        await fetchLifecycle({ cwd });
        const out: RelayPending[] = [];
        for (const p of await pendingGatesByPlan(digest, { cwd })) {
          const digestAsked = p.planDigest ?? p.changeSet;
          if (!digestAsked) continue;
          const fact = latestPendingGate((await readGateLedger(p.op, { cwd })).pending.filter((f) => f.environment === p.environment), p.gate);
          const q = fact?.answer;
          out.push({
            op: p.op,
            gate: p.gate,
            digest: digestAsked,
            ...(p.environment !== undefined ? { environment: p.environment } : {}),
            ...(fact?.request ? { request: fact.request } : {}),
            ...(q ? { question: { point: q.point, id: q.id, ...(q.pass ? { pass: q.pass } : {}) } } : {}),
          });
        }
        return out;
      }),
    answer: (input) =>
      one(async () => {
        const { answerPoint } = await import("../../workspace/decide");
        const doc = await answerPoint({ cwd, id: input.id, answer: input.answer, by: [input.by], relayedBy: input.relayedBy });
        if ("error" in doc) return { ok: false as const, error: `${doc.error.code}: ${doc.error.message}` };
        if (doc.question.state !== "answered") return { ok: false as const, error: `the question is ${doc.question.state}: ${input.by}'s answer does not settle it on its own` };
        const { pushLifecycleRebasing } = await import("../../lifecycle/git");
        await pushLifecycleRebasing({ cwd }).catch(() => undefined);
        return { ok: true as const };
      }),
    approve: (input) =>
      one(async () => {
        const { recordGateApproval } = await import("./approve");
        // chant approve prints why it refused; the relay sends that line to the thread.
        const said: string[] = [];
        const was = console.error;
        console.error = (...parts: unknown[]) => {
          said.push(parts.map(String).join(" "));
          was(...parts);
        };
        try {
          const out = await recordGateApproval(input.op, input.gate, {
            origin: "cli",
            actor: input.actor,
            relayedBy: input.relayedBy,
            plan: input.digest,
            ...(input.environment !== undefined ? { environment: input.environment } : {}),
            cwd,
          });
          if (out.ok) return { ok: true as const };
          // eslint-disable-next-line no-control-regex
          const reason = said.map((l) => l.replace(/\u001b\[[0-9;]*m/g, "").trim()).filter(Boolean)[0];
          return { ok: false as const, error: reason ?? `chant approve ${input.op} ${input.gate} refused the approval` };
        } finally {
          console.error = was;
        }
      }),
  };
}

/** The flags and variables that make the relay clone the repo itself (#4759). */
export interface RelayRepoOptions {
  repo?: string;
  tokenEnv?: string;
  forge?: string;
  host?: string;
  port?: string;
}

/** `chant notify relay`. Runs until the process is stopped. */
export async function runNotifyRelay(ctx: CommandContext): Promise<number> {
  const a = ctx.args;
  return serveNotifyRelay({
    ...(a.repoUrl ? { repo: a.repoUrl } : {}),
    ...(a.tokenEnv ? { tokenEnv: a.tokenEnv } : {}),
    ...(a.forge ? { forge: a.forge } : {}),
    ...(a.host ? { host: a.host } : {}),
    ...(a.port?.[0] ? { port: a.port[0] } : {}),
  });
}

/** Read the settings, clone when asked, and serve. Runs until the process is stopped. */
export async function serveNotifyRelay(o: RelayRepoOptions, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const fail = (why: string): number => {
    console.error(formatError({ message: `chant notify relay did not start: ${why}` }));
    return CHANT_EXIT.failed;
  };
  const read = relaySettingsFromEnv({ ...env, ...(o.host ? { [RELAY_ENV.host]: o.host } : {}), ...(o.port ? { [RELAY_ENV.port]: o.port } : {}) });
  if ("error" in read) return fail(read.error);
  const words = activeProductWords();
  const principal = env[RELAY_ENV.principal]?.trim() || `${words.product}-relay`;
  if (/[\r\n]/.test(principal)) return fail(`${RELAY_ENV.principal} is one principal on one line`);
  let cwd = process.cwd();
  const repoUrl = o.repo ?? (env[RELAY_REPO_ENV.repo] || undefined);
  if (repoUrl) {
    const tokenEnv = o.tokenEnv ?? RELAY_REPO_ENV.token;
    const { prepareRelayCheckout } = await import("../../notify-relay-repo");
    const made = await prepareRelayCheckout({ url: repoUrl, token: env[tokenEnv]?.trim() ?? "", forge: o.forge ?? (env[RELAY_REPO_ENV.forge] || undefined), env });
    if ("error" in made) return fail(made.error.startsWith("the token is empty") ? `${tokenEnv} is empty: the relay pushes approvals with an approve-only token` : made.error);
    // The token as a git header for this process's git calls only: the relay fetches and pushes chant/lifecycle with it.
    Object.assign(process.env, made.gitEnv);
    cwd = made.dir;
    // chant approve writes and pushes the ledger of the process's directory.
    process.chdir(cwd);
    console.error(formatInfo(`cloned ${made.repo.path} (${made.repo.forge}, default branch ${made.branch}) into ${cwd}, pushing as ${made.user}`));
  } else if (o.tokenEnv || o.forge) {
    return fail("--token-env and --forge go with --repo <url>");
  }
  // #5329: the relay starts the alert agent's workflow with a token that can do that and nothing else.
  let dispatch: RelayDeps["dispatch"];
  const dispatchToken = env[RELAY_ENV.alertDispatchToken]?.trim();
  if (read.settings.alertSecrets && dispatchToken) {
    if (!repoUrl) return fail(`${RELAY_ENV.alertDispatchToken} goes with --repo <url>, the repository whose workflow it starts`);
    const { checkDispatchToken, dispatchAgentWorkflow, relayRepo, WORKFLOW_FILE } = await import("../../notify-relay-repo");
    const repo = relayRepo(repoUrl, o.forge ?? (env[RELAY_REPO_ENV.forge] || undefined));
    if ("error" in repo) return fail(repo.error);
    const workflow = env[RELAY_ENV.alertWorkflow]?.trim();
    if (repo.forge !== "gitlab" && !(workflow && WORKFLOW_FILE.test(workflow))) return fail(`${RELAY_ENV.alertWorkflow} names the alert agent's workflow file, such as ${words.product}-alert-agent.yml`);
    const checked = await checkDispatchToken(repo, dispatchToken);
    if ("error" in checked) return fail(`${RELAY_ENV.alertDispatchToken} may only start a workflow, and this one can do more: ${checked.error}`);
    const branch = (await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd })).stdout.trim();
    dispatch = () => dispatchAgentWorkflow({ repo, token: dispatchToken, branch, ...(workflow ? { workflow } : {}) });
  }
  const deps = checkoutRelayDeps(cwd, principal, dispatch);
  const { url } = await startRelayServer(read.settings, deps, { host: read.host, port: read.port, log: (line) => console.error(formatInfo(line)) });
  const alertSources = Object.keys(read.settings.alertSecrets ?? {});
  console.error(formatInfo(`${words.product} notify relay listens at ${url} (POST /slack, POST /teams, GET /healthz), recording approvals relayed by ${principal}`));
  if (alertSources.length > 0) console.error(formatInfo(`alerts from ${alertSources.join(", ")} at POST /alert/<source>; ${dispatch ? "each new alert starts the agent's workflow" : `no ${RELAY_ENV.alertDispatchToken}, so the agent's schedule picks alerts up`}`));
  await new Promise<void>(() => {});
  return 0;
}
