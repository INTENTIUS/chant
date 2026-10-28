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
 * Each click fetches `chant/lifecycle`, reads the signers file at base, and
 * records through `recordGateApproval`, one click at a time, so two clicks
 * never race on the ledger.
 */
import { activeProductWords } from "../../ci-product-words";
import { CHANT_EXIT } from "../../exit-codes";
import { DEFAULT_RELAY_MAX_AGE_SECONDS } from "../../notify";
import { DEFAULT_RELAY_HOST, DEFAULT_RELAY_PORT, RELAY_ENV, startRelayServer, type RelayDeps, type RelayPending, type RelaySettings } from "../../notify-relay";
import { formatError, formatInfo } from "../format";
import type { CommandContext } from "../registry";

/** The relay's settings, read from `env`, or the first problem with them. */
export function relaySettingsFromEnv(env: NodeJS.ProcessEnv): { settings: RelaySettings; host: string; port: number } | { error: string } {
  const key = env[RELAY_ENV.key];
  if (!key) return { error: `${RELAY_ENV.key} is not set; it holds the key notify signs the buttons with (notify.relay on the sending side)` };
  const slackSecret = env[RELAY_ENV.slackSecret] || undefined;
  const teamsSecret = env[RELAY_ENV.teamsSecret] || undefined;
  if (!slackSecret && !teamsSecret) return { error: `set ${RELAY_ENV.slackSecret}, ${RELAY_ENV.teamsSecret} or both, so the relay can verify a click` };
  const maxAgeText = env[RELAY_ENV.maxAge];
  const maxAge = maxAgeText === undefined || maxAgeText === "" ? DEFAULT_RELAY_MAX_AGE_SECONDS : Number(maxAgeText);
  if (!Number.isInteger(maxAge) || maxAge <= 0) return { error: `${RELAY_ENV.maxAge} is a whole number of seconds (got ${JSON.stringify(maxAgeText)})` };
  const portText = env[RELAY_ENV.port];
  const port = portText === undefined || portText === "" ? DEFAULT_RELAY_PORT : Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65535) return { error: `${RELAY_ENV.port} is a port number (got ${JSON.stringify(portText)})` };
  const slackResponse = env[RELAY_ENV.slackResponse]?.split(",").map((s) => s.trim()).filter(Boolean);
  return {
    settings: { key, ...(slackSecret ? { slackSecret } : {}), ...(teamsSecret ? { teamsSecret } : {}), maxAgeSeconds: maxAge, ...(slackResponse?.length ? { slackResponse } : {}) },
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

/** The relay's reads and writes against the checkout at `cwd`. */
export function checkoutRelayDeps(cwd: string, principal: string): RelayDeps {
  const words = activeProductWords();
  const one = serial();
  return {
    principal,
    words,
    async signers() {
      const { scopeSource } = await import("../../workspace/write-scope");
      const policy = scopeSource(cwd).policy;
      return { signers: policy.signers, path: policy.signersPath };
    },
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
          out.push({ op: p.op, gate: p.gate, digest: digestAsked, ...(p.environment !== undefined ? { environment: p.environment } : {}), ...(fact?.request ? { request: fact.request } : {}) });
        }
        return out;
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

/** `chant notify relay`. Runs until the process is stopped. */
export async function runNotifyRelay(_ctx: CommandContext): Promise<number> {
  const read = relaySettingsFromEnv(process.env);
  if ("error" in read) {
    console.error(formatError({ message: `chant notify relay did not start: ${read.error}` }));
    return CHANT_EXIT.failed;
  }
  const words = activeProductWords();
  const principal = process.env[RELAY_ENV.principal]?.trim() || `${words.product}-relay`;
  const deps = checkoutRelayDeps(process.cwd(), principal);
  const { url } = await startRelayServer(read.settings, deps, { host: read.host, port: read.port, log: (line) => console.error(formatInfo(line)) });
  console.error(formatInfo(`${words.product} notify relay listens at ${url} (POST /slack, POST /teams, GET /healthz), recording approvals relayed by ${principal}`));
  await new Promise<void>(() => {});
  return 0;
}
