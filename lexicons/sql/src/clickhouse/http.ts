/**
 * The smallest ClickHouse client chant needs: one SQL statement over the HTTP
 * interface, rows back as JSON objects.
 *
 * No driver dependency. ClickHouse's HTTP interface takes the statement as the
 * request body and `default_format=JSONEachRow` returns one JSON object per
 * line, which is all generation (and, later, observation and import) reads.
 */

/** Where a server answers, and as whom. */
export interface ClickHouseEndpoint {
  /** Base URL of the HTTP interface, e.g. `http://127.0.0.1:8123`. */
  url: string;
  user?: string;
  password?: string;
}

/** A query the server refused, with the server's own message. */
export class ClickHouseQueryError extends Error {
  constructor(
    readonly status: number,
    readonly serverMessage: string,
    readonly sql: string,
  ) {
    super(`ClickHouse answered ${status}: ${serverMessage.trim().split("\n")[0]}`);
    this.name = "ClickHouseQueryError";
  }
}

/** Run one statement and return its rows. A statement that returns nothing yields `[]`. */
export async function clickhouseQuery<Row = Record<string, unknown>>(
  endpoint: ClickHouseEndpoint,
  sql: string,
): Promise<Row[]> {
  const headers: Record<string, string> = { "content-type": "text/plain; charset=utf-8" };
  if (endpoint.user !== undefined) headers["X-ClickHouse-User"] = endpoint.user;
  if (endpoint.password !== undefined) headers["X-ClickHouse-Key"] = endpoint.password;
  const res = await fetch(`${endpoint.url.replace(/\/$/, "")}/?default_format=JSONEachRow`, {
    method: "POST",
    headers,
    body: sql,
  });
  const text = await res.text();
  if (!res.ok) throw new ClickHouseQueryError(res.status, text, sql);
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Row);
}

/** True when the server answers `/ping`. */
export async function clickhousePing(endpoint: ClickHouseEndpoint): Promise<boolean> {
  try {
    const res = await fetch(`${endpoint.url.replace(/\/$/, "")}/ping`);
    return res.ok;
  } catch {
    return false;
  }
}
