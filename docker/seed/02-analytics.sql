-- shop_dev.analytics: a second schema, plus a large table (500k rows)
-- for exercising the virtualised results grid and the row cap.

SELECT setseed(0.17);

CREATE SCHEMA analytics;

CREATE TABLE analytics.sessions (
  id           bigserial   PRIMARY KEY,
  token        uuid        NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  customer_id  bigint      REFERENCES public.customers (id),
  started_at   timestamptz NOT NULL,
  ended_at     timestamptz,
  user_agent   text,
  ip           inet
);

CREATE TABLE analytics.events (
  id           bigserial   PRIMARY KEY,
  session_id   bigint      NOT NULL REFERENCES analytics.sessions (id),
  name         text        NOT NULL,
  properties   jsonb       NOT NULL DEFAULT '{}'::jsonb,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_session_id_idx  ON analytics.events (session_id);
CREATE INDEX events_occurred_at_idx ON analytics.events (occurred_at);

INSERT INTO analytics.sessions (customer_id, started_at, ended_at, user_agent, ip)
SELECT CASE WHEN random() < 0.35 THEN NULL ELSE 1 + floor(random() * 48213)::bigint END,
       started,
       CASE WHEN random() < 0.1 THEN NULL ELSE started + random() * interval '40 minutes' END,
       (ARRAY['Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) Safari/605.1.15',
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/129.0',
              'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Mobile/15E148',
              'Mozilla/5.0 (X11; Linux x86_64) Firefox/131.0'])[1 + floor(random() * 4)::int],
       ('10.' || floor(random() * 255) || '.' || floor(random() * 255) || '.' || floor(1 + random() * 254))::inet
FROM (
  SELECT timestamptz '2026-10-08 12:00:00+00' - (60000 - g) * interval '2 minutes' AS started
  FROM generate_series(1, 60000) AS g
) s;

INSERT INTO analytics.events (session_id, name, properties, occurred_at)
SELECT sid,
       ev,
       CASE ev
         WHEN 'page_view'   THEN jsonb_build_object('path', (ARRAY['/', '/shop', '/cart', '/account', '/product'])[1 + floor(random() * 5)::int])
         WHEN 'search'      THEN jsonb_build_object('q', (ARRAY['mug', 'tote', 'linen apron', 'gift', 'pen'])[1 + floor(random() * 5)::int], 'results', floor(random() * 40)::int)
         WHEN 'add_to_cart' THEN jsonb_build_object('product_id', 1 + floor(random() * 1286)::int, 'qty', 1 + floor(random() * 3)::int)
         WHEN 'checkout'    THEN jsonb_build_object('step', 1 + floor(random() * 3)::int)
         ELSE '{}'::jsonb
       END,
       timestamptz '2026-10-08 12:00:00+00' - (500000 - g) * interval '14 seconds'
FROM (
  SELECT g,
         1 + (g / 9)::bigint % 60000 AS sid,
         (ARRAY['page_view', 'page_view', 'page_view', 'search', 'add_to_cart', 'checkout', 'login'])[1 + floor(random() * 7)::int] AS ev
  FROM generate_series(1, 500000) AS g
) s;
