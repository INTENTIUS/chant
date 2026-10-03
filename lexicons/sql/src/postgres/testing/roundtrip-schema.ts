/**
 * The schema the live round trip creates on its source server: every object
 * kind the dialect declares, with what the catalog's printers rewrite most
 * (type aliases, literal casts, `IN` lists, unnamed constraints, identity and
 * sequence options, storage parameters, comments), an extension and the
 * domain over its type, a partitioned table and a partition, an ORM's
 * revision table that import leaves out, and an object carrying chant's
 * ownership trailer.
 */
export const ROUNDTRIP_SCHEMA = `
CREATE SCHEMA app;
COMMENT ON SCHEMA app IS 'The shop';
CREATE EXTENSION citext WITH SCHEMA app;
CREATE TYPE app.order_status AS ENUM ('placed', 'paid', 'shipped');
CREATE DOMAIN app.email AS app.citext CONSTRAINT email_shape CHECK (VALUE LIKE '%@%');
COMMENT ON CONSTRAINT email_shape ON DOMAIN app.email IS 'needs an @';
CREATE SEQUENCE app.invoice_seq AS integer START WITH 1000 CACHE 10;
CREATE TABLE app.users (
  id bigint GENERATED ALWAYS AS IDENTITY (START WITH 10) PRIMARY KEY,
  email app.email NOT NULL UNIQUE,
  plan text NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro')),
  created_at timestamptz NOT NULL DEFAULT now()
) WITH (fillfactor = 90);
COMMENT ON TABLE app.users IS 'Accounts [chant managed-by=chant stack=shop env=e2e]';
COMMENT ON COLUMN app.users.email IS 'Login name';
CREATE TABLE app.orders (
  id serial PRIMARY KEY,
  user_id bigint NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
  invoice_no integer NOT NULL DEFAULT nextval('app.invoice_seq'),
  status app.order_status NOT NULL DEFAULT 'placed',
  amount numeric(12, 2) NOT NULL CONSTRAINT amount_positive CHECK (amount >= 0),
  discount int DEFAULT -1,
  total numeric GENERATED ALWAYS AS (amount * 2) STORED,
  placed_at timestamp(3) without time zone
);
CREATE INDEX orders_user_idx ON app.orders (user_id, placed_at DESC) WHERE status <> 'shipped';
CREATE UNIQUE INDEX orders_invoice_idx ON app.orders USING btree (invoice_no) INCLUDE (amount);
CREATE TABLE app.measures (ts date NOT NULL, v double precision) PARTITION BY RANGE (ts);
CREATE TABLE app.measures_2026 PARTITION OF app.measures FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
CREATE VIEW app.order_totals AS
  SELECT u.id AS user_id, u.email, count(o.id) AS n, coalesce(sum(o.amount), 0) AS total
  FROM app.users u LEFT JOIN app.orders o ON o.user_id = u.id
  GROUP BY u.id, u.email;
CREATE MATERIALIZED VIEW app.daily AS SELECT placed_at::date AS day, count(*) AS n FROM app.orders GROUP BY 1 WITH NO DATA;
CREATE TABLE public._prisma_migrations (id varchar(36) PRIMARY KEY, checksum varchar(64) NOT NULL);
`;
