// Webhook receiver — event source #1. POST /alert starts a triage workflow.
// This is what the WebApp manifest deploys; run it locally with `npm run webhook`.
import { createServer } from "node:http";
import { startTriage } from "./triage-client.js";
import { alertFromWebhook } from "./parse.js";

const port = Number(process.env.PORT ?? 8080);

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200);
    res.end("ok");
    return;
  }
  if (req.method === "POST" && req.url === "/alert") {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      void (async () => {
        try {
          const alert = alertFromWebhook(data ? JSON.parse(data) : {});
          const id = await startTriage(alert);
          res.writeHead(202, { "content-type": "application/json" });
          res.end(JSON.stringify({ started: id }));
        } catch (err) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: String(err) }));
        }
      })();
    });
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

server.listen(port, () => {
  console.log(`alert-triage webhook listening on :${port} (POST /alert)`);
});
