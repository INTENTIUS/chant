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
 */
import http from "node:http";

const PROXY_PORT = Number(process.env.PROXY_PORT || 4692);
const TARGET_PORT = Number(process.env.TARGET_PORT || 4691);
const TARGET_HOST = process.env.TARGET_HOST || "127.0.0.1";

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
    const action = actionFor(req, body.toString("utf8"));
    counts.total++;
    counts.byAction[action] = (counts.byAction[action] || 0) + 1;

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
  });
});

server.listen(PROXY_PORT, () => {
  console.log(`api-call-proxy: listening on :${PROXY_PORT}, forwarding to ${TARGET_HOST}:${TARGET_PORT}`);
});
