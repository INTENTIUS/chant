// The stub app (INTENTIUS/chant#3174, arugula-salad/studio#288): it answers
// /health and shows the workspace's name, so a host can run the box contract
// before there is anything to build. A work item replaces it with the real app.
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

export const NAME = "{{chant:name}}";

export const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, revision: process.env.APP_REVISION ?? null }));
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><title>${NAME}</title><h1>${NAME}</h1><p>Nothing is built here yet.</p>\n`);
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) server.listen(Number(process.env.PORT ?? 3000));
