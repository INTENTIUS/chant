import { index, schema, table } from "@intentius/chant-lexicon-sql/postgres";

export const telemetry = schema`CREATE SCHEMA telemetry`;

// A partitioned table's primary key has to include the partition key, so
// the key is (id, occurred_at). Rows route to the partition whose range holds
// occurred_at; a row outside every range goes to the default partition
// instead of failing the insert.
export const events = table`
  CREATE TABLE ${telemetry}.events (
    id          bigint GENERATED ALWAYS AS IDENTITY,
    occurred_at timestamptz NOT NULL,
    device_id   bigint NOT NULL,
    kind        text NOT NULL,
    payload     jsonb NOT NULL DEFAULT '{}',
    PRIMARY KEY (id, occurred_at)
  ) PARTITION BY RANGE (occurred_at)`;

// One partition per month, created ahead of time. Ranges are half-open: the
// upper bound belongs to the next month.
export const eventsOct = table`
  CREATE TABLE ${telemetry}.events_2026_10 PARTITION OF ${events} FOR VALUES FROM ('2026-10-01') TO ('2026-11-01')`;

export const eventsNov = table`
  CREATE TABLE ${telemetry}.events_2026_11 PARTITION OF ${events} FOR VALUES FROM ('2026-11-01') TO ('2026-12-01')`;

export const eventsDec = table`
  CREATE TABLE ${telemetry}.events_2026_12 PARTITION OF ${events} FOR VALUES FROM ('2026-12-01') TO ('2027-01-01')`;

export const eventsDefault = table`
  CREATE TABLE ${telemetry}.events_default PARTITION OF ${events} DEFAULT`;

// An index on the parent exists on every partition, present and future.
export const eventsByDevice = index`
  CREATE INDEX events_by_device_idx ON ${events} (${events.columns.device_id}, ${events.columns.occurred_at} DESC)`;
