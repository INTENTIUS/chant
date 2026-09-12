#!/usr/bin/env node
/**
 * chant#2403 — a counting reverse proxy in front of floci.
 *
 * The cost number the bench wants ("what does a read cost, in API calls")
 * has to be MEASURED, not asserted — the same discipline choudoufu's own
 * measuring-choudoufu skill insists on. chant's read path speaks the AWS
 * Query protocol straight to CloudFormation (DescribeStackResources,
 * DescribeStacks — see lexicons/aws/src/plugin.ts's describeResources), so
 * every one of those calls is a plain HTTP POST with `Action=<Name>` in an
 * x-www-form-urlencoded body. This proxy sits between the AWS client and
 * floci, counts requests by that Action, and forwards the body unchanged —
 * floci never sees anything different from a direct connection.
 *
 * Usage: node scripts/api-call-proxy.mjs
 *   env PROXY_PORT (default 4692), TARGET_PORT (default 4691, floci's own)
 *
 * Two extra endpoints, handled locally rather than forwarded:
 *   GET /__counts  -> current { total, byAction } as JSON
 *   POST /__reset  -> zeroes the counters, returns the same shape
 *
 * test/scale-estate.sh points AWS_ENDPOINT_URL at this proxy only around the
 * read-back step (`chant lifecycle plan`), resetting counts immediately
 * before and reading them immediately after — so the reported number is
 * exactly what that one command cost, not the deploy phase's own calls.
 *
 * chant#2409 — optional stall injection, off by default and inert unless
 * explicitly enabled, used to PROVE the heartbeat-timeout/outlier/evidence
 * fix in test/scale-estate.sh against a call that reproducibly hangs rather
 * than waiting on luck (the incident that opened #2409 only happened once).
 * When STALL_ACTION is set, a matching request is never forwarded and never
 * answered — the connection is simply held open, exactly like the emulator
 * call that blocked for 13 minutes in the incident — until the client gives
 * up on its own (that's the harness's own poll timeout, once #2409 lands) or
 * MAX_STALL_MS elapses, whichever is first; MAX_STALL_MS is a safety net
 * against leaking a socket forever if this proxy is ever pointed at by a
 * caller with no timeout of its own, not a value any real test should hit.
 *   env STALL_ACTION  action name to stall (e.g. DescribeStackEvents); unset
 *                     (default) disables stalling entirely
 *   env STALL_STACK   optional: only stall when the request body's
 *                     StackName matches exactly (unset = stall every
 *                     matching action, regardless of stack)
 *   env STALL_COUNT   how many matching requests to stall before letting the
 *                     rest through normally (default 1)
 *   env STALL_DELAY_MS  optional: instead of holding a matching request open
 *                     until the client gives up, delay it by exactly this
 *                     many ms and then forward it — a real, bounded delay
 *                     rather than a hang. Used to prove the OUTLIER side of
 *                     #2409 (a stack that is honestly, measurably slower
 *                     than the others) independent of the poll-timeout
 *                     side above: delay a call chant's OWN deploy depends
 *                     on (e.g. CreateStack) and that one stack's real
 *                     wall-clock duration grows for real, with no call ever
 *                     failing to answer.
 */
import http from "node:http";

const PROXY_PORT = Number(process.env.PROXY_PORT || 4692);
const TARGET_PORT = Number(process.env.TARGET_PORT || 4691);
const TARGET_HOST = process.env.TARGET_HOST || "127.0.0.1";

const STALL_ACTION = process.env.STALL_ACTION || "";
const STALL_STACK = process.env.STALL_STACK || "";
const STALL_COUNT = Number(process.env.STALL_COUNT || 1);
const STALL_DELAY_MS = process.env.STALL_DELAY_MS ? Number(process.env.STALL_DELAY_MS) : 0;
const MAX_STALL_MS = 5 * 60 * 1000;
let stallsSoFar = 0;

let counts = { total: 0, byAction: {} };

/** The AWS Query protocol (CloudFormation, SQS, SNS, ...) carries the API
 * name as `Action=<Name>` in an x-www-form-urlencoded body. The AWS JSON
 * protocol (DynamoDB, ...) carries it in the `X-Amz-Target` header instead
 * as `<Service>.<Action>` — checked first since it needs no body parse. */
function actionFor(req, bodyText) {
  const target = req.headers["x-amz-target"];
  if (target) return String(target).split(".").pop();
  const contentType = req.headers["content-type"] || "";
  if (contentType.includes("x-www-form-urlencoded")) {
    const params = new URLSearchParams(bodyText);
    const action = params.get("Action");
    if (action) return action;
  }
  return "unknown";
}

const server = http.createServer((req, res) => {
  if (req.url === "/__counts" && req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(counts));
    return;
  }
  if (req.url === "/__reset" && req.method === "POST") {
    counts = { total: 0, byAction: {} };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(counts));
    return;
  }

  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const bodyText = body.toString("utf8");
    const action = actionFor(req, bodyText);
    counts.total++;
    counts.byAction[action] = (counts.byAction[action] || 0) + 1;

    if (
      STALL_ACTION &&
      action === STALL_ACTION &&
      stallsSoFar < STALL_COUNT &&
      (!STALL_STACK || new URLSearchParams(bodyText).get("StackName") === STALL_STACK)
    ) {
      stallsSoFar++;
      const n = stallsSoFar;
      const stackName = new URLSearchParams(bodyText).get("StackName") || "?";

      if (STALL_DELAY_MS > 0) {
        console.error(
          `api-call-proxy: DELAYING ${action} request #${n}/${STALL_COUNT} (StackName=${stackName}) by ${STALL_DELAY_MS}ms, then forwarding it for real (chant#2409 proof)`,
        );
        setTimeout(() => {
          console.error(`api-call-proxy: delay elapsed on request #${n} — forwarding now`);
          forward(req, res, body);
        }, STALL_DELAY_MS);
        return;
      }

      console.error(
        `api-call-proxy: STALLING ${action} request #${n}/${STALL_COUNT} (StackName=${stackName}) — holding the connection, answering nothing (chant#2409 proof)`,
      );
      const safety = setTimeout(() => {
        console.error(`api-call-proxy: safety net hit after ${MAX_STALL_MS}ms on stalled request #${n} — forwarding it late`);
        forward(req, res, body);
      }, MAX_STALL_MS);
      res.on("close", () => {
        clearTimeout(safety);
        console.error(`api-call-proxy: stalled request #${n} gave up waiting (client disconnected) after the client's own timeout`);
      });
      return;
    }

    forward(req, res, body);
  });
});

function forward(req, res, body) {
  if (res.writableEnded || res.destroyed) return; // the client already gave up (see the safety net above)
  const upstream = http.request(
    { host: TARGET_HOST, port: TARGET_PORT, path: req.url, method: req.method, headers: req.headers },
    (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    },
  );
  upstream.on("error", (err) => {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(`api-call-proxy: upstream error: ${err}`);
  });
  upstream.end(body);
}

server.listen(PROXY_PORT, () => {
  console.log(`api-call-proxy: listening on :${PROXY_PORT}, forwarding to ${TARGET_HOST}:${TARGET_PORT}`);
});
