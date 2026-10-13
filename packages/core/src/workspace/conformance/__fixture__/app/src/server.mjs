// The reader conformance workspace's product (#2679): the request handler of
// a small web app, with no dependencies. The suite reads
// `graph --intent app/src/server.mjs:19`, so line 19 is the home page's
// status line, as it is in chant's reference-workspace/app/src/server.mjs.
// Nothing here opens a port: chant's own packages never listen (#2657), and
// this file ships in one.

/** The app's display name. */
export const APP_NAME = "Conformance app";

/** The home page. */
export const HOME = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${APP_NAME}</title></head>
<body>
<header><h1>${APP_NAME}</h1></header>
<main>
<!-- the status line -->
<p id="status">Running.</p>
</main>
</body>
</html>
`;

/** Answer one request with a status and a body. */
export function handle(url) {
  if (url === "/healthz") return { status: 200, type: "application/json", body: JSON.stringify({ ok: true }) };
  return { status: 200, type: "text/html; charset=utf-8", body: HOME };
}
