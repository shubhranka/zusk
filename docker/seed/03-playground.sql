-- shop_dev.playground: one row per interesting Postgres type, to check
-- type colouring, NULL rendering, wide values and copy behaviour.

SELECT setseed(0.73);

CREATE SCHEMA playground;

CREATE DOMAIN playground.email_address AS text CHECK (VALUE ~ '@');

CREATE TABLE playground.type_samples (
  id          integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  label       varchar(40)  NOT NULL,
  small_int   smallint,
  big_int     bigint,
  amount      numeric(12,4),
  ratio       double precision,
  price       money,
  flag        boolean,
  born_on     date,
  wake_at     time,
  created_at  timestamptz  DEFAULT now(),
  local_ts    timestamp,
  duration    interval,
  uid         uuid         DEFAULT gen_random_uuid(),
  payload     jsonb,
  tags        text[],
  scores      integer[],
  addr        inet,
  mac         macaddr,
  raw         bytea,
  contact     playground.email_address,
  span        int4range,
  doubled     bigint GENERATED ALWAYS AS (big_int * 2) STORED,
  notes       text
);

INSERT INTO playground.type_samples
  (label, small_int, big_int, amount, ratio, price, flag, born_on, wake_at, local_ts, duration,
   payload, tags, scores, addr, mac, raw, contact, span, notes)
SELECT 'sample ' || g,
       CASE WHEN g % 7 = 0 THEN NULL ELSE (g * 37 % 32000)::smallint END,
       CASE WHEN g % 11 = 0 THEN NULL ELSE g::bigint * 1000003 END,
       round((random() * 100000)::numeric, 4),
       CASE WHEN g % 13 = 0 THEN 'NaN'::float8 ELSE random() END,
       (random() * 500)::numeric::money,
       CASE WHEN g % 5 = 0 THEN NULL ELSE g % 2 = 0 END,
       date '1960-01-01' + (g * 97 % 20000),
       time '06:00' + g * interval '7 minutes',
       timestamp '2026-01-01 00:00' + g * interval '5 hours 17 minutes',
       make_interval(days => g % 30, hours => g % 24, mins => g % 60),
       CASE WHEN g % 6 = 0 THEN NULL
            ELSE jsonb_build_object('n', g, 'even', g % 2 = 0, 'nested', jsonb_build_object('tags', jsonb_build_array('a', 'b'))) END,
       (ARRAY['red', 'green', 'blue'])[1:1 + g % 3],
       ARRAY[g, g * 2, g * 3],
       ('192.168.' || (g % 255) || '.' || (g * 3 % 255))::inet,
       ('08:00:2b:01:02:' || lpad(to_hex(g % 255), 2, '0'))::macaddr,
       decode(md5(g::text), 'hex'),
       'user' || g || '@example.com',
       int4range(g, g + 10),
       CASE WHEN g % 4 = 0 THEN NULL
            WHEN g % 9 = 0 THEN repeat('A long note that keeps going so the grid has to truncate it. ', 8)
            ELSE 'note ' || g END
FROM generate_series(1, 240) AS g;

-- A wide table: 40 columns, for horizontal scrolling.
DO $$
DECLARE
  cols text := '';
BEGIN
  FOR i IN 1..40 LOOP
    cols := cols || format(', col_%s integer', lpad(i::text, 2, '0'));
  END LOOP;
  EXECUTE format('CREATE TABLE playground.wide_table (id serial PRIMARY KEY%s)', cols);
END
$$;

INSERT INTO playground.wide_table (col_01, col_02, col_03, col_04, col_05, col_10, col_20, col_30, col_40)
SELECT g, g * 2, g * 3, g * 4, g * 5, g * 10, g * 20, g * 30, g * 40
FROM generate_series(1, 500) AS g;

CREATE PROCEDURE playground.bump_stock(p_product integer, p_by integer DEFAULT 1)
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.products SET stock = stock + p_by WHERE id = p_product;
END
$$;

CREATE FUNCTION playground.customer_count(p_country char(2)) RETURNS bigint
LANGUAGE sql STABLE AS $$
  SELECT count(*) FROM public.customers WHERE country = p_country;
$$;
