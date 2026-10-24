/**
 * The schema the live round trip creates on its source server: every object
 * kind the dialect declares, with what the catalog's printers rewrite most
 * (type aliases, literal casts, `IN` lists, unnamed constraints, identity and
 * sequence options, storage parameters, comments), an extension and the
 * domain over its type, a collation, composite and range types (and a
 * multirange column), plain and ordered-set aggregates, a cast and an event
 * trigger, an operator, extended statistics, a foreign data wrapper and server, and a
 * publication (#3911), a partitioned table and a partition, an ORM's
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
CREATE COLLATION app.ci (provider = icu, locale = 'und-u-ks-level2', deterministic = false);
COMMENT ON COLLATION app.ci IS 'Case-insensitive';
CREATE TYPE app.pair AS (a integer, b text COLLATE "C");
COMMENT ON TYPE app.pair IS 'Two values';
CREATE TYPE app.floatrange AS RANGE (SUBTYPE = float8, SUBTYPE_DIFF = float8mi);
CREATE TABLE app.people (id integer PRIMARY KEY, nick text COLLATE app.ci, span app.floatrange, tags app.floatmultirange);
CREATE FUNCTION app.add2(a integer, b integer) RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT a + b $$;
CREATE AGGREGATE app.total(integer) (SFUNC = app.add2, STYPE = integer, INITCOND = '0', PARALLEL = SAFE);
COMMENT ON AGGREGATE app.total(integer) IS 'A sum';
CREATE FUNCTION app.middle(v double precision[]) RETURNS double precision LANGUAGE sql IMMUTABLE AS $$ SELECT v[(array_length(v, 1) + 1) / 2] $$;
CREATE AGGREGATE app.median_of(ORDER BY double precision) (SFUNC = pg_catalog.array_append, STYPE = double precision[], FINALFUNC = app.middle);
CREATE FUNCTION app.pair_text(p app.pair) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT p.a || ':' || p.b $$;
CREATE CAST (app.pair AS text) WITH FUNCTION app.pair_text(app.pair) AS ASSIGNMENT;
COMMENT ON CAST (app.pair AS text) IS 'a:b';
CREATE FUNCTION app.audit() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN END $$;
CREATE EVENT TRIGGER app_audit ON ddl_command_end WHEN TAG IN ('CREATE TABLE') EXECUTE FUNCTION app.audit();
CREATE FUNCTION app.int_same(a integer, b integer) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT a = b $$;
CREATE OPERATOR app.=== (FUNCTION = app.int_same, LEFTARG = integer, RIGHTARG = integer, COMMUTATOR = OPERATOR(app.===), RESTRICT = eqsel, JOIN = eqjoinsel, HASHES, MERGES);
COMMENT ON OPERATOR app.===(integer, integer) IS 'Same value';
CREATE STATISTICS app.orders_stats (dependencies) ON user_id, status FROM app.orders;
COMMENT ON STATISTICS app.orders_stats IS 'Users and their order states';
CREATE FOREIGN DATA WRAPPER app_fdw OPTIONS (debug 'true');
COMMENT ON FOREIGN DATA WRAPPER app_fdw IS 'Remote tables';
CREATE SERVER app_replica TYPE 'pg' VERSION '16' FOREIGN DATA WRAPPER app_fdw OPTIONS (host 'db.internal', port '5432');
COMMENT ON SERVER app_replica IS 'The read replica';
CREATE PUBLICATION app_pub FOR TABLE app.orders, app.users WITH (publish = 'insert, update');
COMMENT ON PUBLICATION app_pub IS 'Order changes';
CREATE TABLE public._prisma_migrations (id varchar(36) PRIMARY KEY, checksum varchar(64) NOT NULL);
`;
