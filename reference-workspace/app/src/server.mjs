// The reference workspace's product. It has no dependencies, so the fixture
// needs no install step of its own. The home page follows the screen spec in
// ../../design/screens/home.json.

import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const HOME = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Reference app</title></head>
<body>
<header><h1>Reference app</h1></header>
<main><p id="status">Running.</p></main>
</body>
</html>
`;

/** Answer one request. Exported so the test can call it without a socket. */
export function handle(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" });
    res.end();
    return;
  }
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(HOME);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found\n");
}

export function createAppServer() {
  return createServer(handle);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const port = Number(process.env.PORT ?? 8080);
  createAppServer().listen(port, () => {
    console.log(`listening on ${port}`);
  });
}
