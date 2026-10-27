-- A second database, so you can add a second connection ("warehouse")
-- and see two connections side by side in the explorer.

ANALYZE;  -- statistics for shop_dev (row estimates in the explorer)

CREATE DATABASE warehouse;
\connect warehouse

SELECT setseed(0.5);

CREATE SCHEMA dw;

CREATE TABLE dw.dim_date (
  date_key    integer PRIMARY KEY,
  day         date    NOT NULL UNIQUE,
  iso_week    integer NOT NULL,
  is_weekend  boolean NOT NULL
);

CREATE TABLE dw.fact_sales (
  id          bigserial     PRIMARY KEY,
  date_key    integer       NOT NULL REFERENCES dw.dim_date (date_key),
  region      text          NOT NULL,
  units       integer       NOT NULL,
  revenue     numeric(12,2) NOT NULL
);

INSERT INTO dw.dim_date
SELECT to_char(d, 'YYYYMMDD')::int, d, extract(week FROM d)::int, extract(isodow FROM d) IN (6, 7)
FROM generate_series(date '2025-01-01', date '2026-12-31', interval '1 day') AS d;

INSERT INTO dw.fact_sales (date_key, region, units, revenue)
SELECT to_char(date '2025-01-01' + (g % 646), 'YYYYMMDD')::int,
       (ARRAY['EMEA', 'AMER', 'APAC'])[1 + g % 3],
       1 + floor(random() * 40)::int,
       round((random() * 4000)::numeric, 2)
FROM generate_series(1, 20000) AS g;

ANALYZE;
