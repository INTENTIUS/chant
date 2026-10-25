/**
 * What the state stores share: the fetch they call, their errors, and how a
 * key goes into a URL. Lifted from terragucci's `report/object-store.ts`
 * (c493e0e), cut to what a state's lock and write need.
 */

export type StoreFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string | Uint8Array }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  /** A store that sends no headers (or a test's fake) gets no conditional writes. */
  headers?: { get(name: string): string | null };
}>;

export class StoreError extends Error {}

/** A conditional write that lost: the object changed (412) or another write to it was in flight (409). */
export class StoreConflict extends StoreError {}

/** A condition on a write: the version the object must still have, or `*` for "there is no object yet". */
export type StoreCondition = { ifMatch: string } | { ifNoneMatch: "*" };

/** A key as a URL path: each segment percent-encoded the strict way (RFC 3986), the slashes kept. */
export const encodePath = (key: string): string => key.split("/").map(encodeStrict).join("/");

export const encodeStrict = (v: string): string => encodeURIComponent(v).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** The first value of an XML element, unescaped. Enough for the small answers these stores send. */
export const xmlText = (xml: string, tag: string): string | undefined => {
  const m = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
  return m?.[1]!.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&").trim();
};

/** The global fetch, as a StoreFetch. */
export const defaultFetch: StoreFetch = (url, init) => fetch(url, init as RequestInit);
