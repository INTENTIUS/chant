import type { RowOf } from "@intentius/chant-lexicon-sql/clickhouse";
import { accounts, clicks, daily, events } from "../src/events";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const ok = <T extends true>(): T | undefined => undefined;

ok<Equal<RowOf<typeof events.table>, { user_id: string; kind: string; ts: string }>>();
ok<Equal<RowOf<typeof daily.table>, { day: string; kind: string; n: string }>>();
ok<Equal<RowOf<typeof clicks.local>, RowOf<typeof clicks.distributed>>>();
ok<Equal<RowOf<typeof accounts.table>, RowOf<"analytics.accounts">>>();

export const typo = events.table.columns.knid;
ok<Equal<RowOf<typeof daily.view>, RowOf<"analytics.daily_mv">>>();
ok<Equal<RowOf<typeof accounts.current>, RowOf<"analytics.accounts_current">>>();
