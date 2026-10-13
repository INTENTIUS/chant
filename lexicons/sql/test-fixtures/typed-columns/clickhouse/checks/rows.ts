import type { ClickHouseTable, RowOf } from "@intentius/chant-lexicon-sql/clickhouse";
import { events, rates } from "../src/schema";
import type { eventsByKind } from "../src/schema";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const ok = <T extends true>(): T | undefined => undefined;

ok<Equal<RowOf<typeof events>, {
  id: string; kind: string; at: string; country: string | null; score: number;
  tags: (string | null)[]; attrs: Record<string, number>; point: { x: number; y: number };
}>>();
ok<Equal<RowOf<typeof rates>, { currency: string; rate: number }>>();
ok<Equal<RowOf<typeof eventsByKind>, { kind: string; n: unknown }>>();

const takesTable = (t: ClickHouseTable) => t.sqlName;
takesTable(events);

export const misspelled = events.columns.contry;
