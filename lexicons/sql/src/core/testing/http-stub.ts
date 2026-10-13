/**
 * A stand-in HTTP server for tests, in every dialect: listens on a random
 * loopback port and answers each request's body with what `answer` returns.
 * A dialect's fake server (the ClickHouse HTTP interface answering its
 * catalog reads) is built on it. Not a SQL engine.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";

export interface StubAnswer {
  status: number;
  text: string;
}

export interface HttpStub {
  url: string;
  close(): Promise<void>;
}

export async function startHttpStub(answer: (body: string, req: IncomingMessage) => StubAnswer): Promise<HttpStub> {
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { status, text } = answer(body, req);
      res.statusCode = status;
      res.end(text);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) };
}
