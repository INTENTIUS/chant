import { Composite } from "@intentius/chant/composite";
import { table } from "../lexicon/index";

export interface EventsTableProps {
  name: string;
  ttlDays: number;
}

// The composite builds the DDL text with its parameters interpolated.
export const EventsTable = Composite<EventsTableProps>(
  (props) => ({
    table: table`
      CREATE TABLE ${props.name} (
        user_id  UUID,
        ts       DateTime
      )
      ENGINE = MergeTree
      ORDER BY (user_id, ts)
      TTL ts + INTERVAL ${props.ttlDays} DAY`,
  }),
  "EventsTable",
);
