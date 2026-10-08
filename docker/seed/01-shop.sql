-- shop_dev: the "public" schema shown in the design mockup.
-- Data is generated deterministically (setseed) so every fresh volume looks the same.

SELECT setseed(0.42);

CREATE TYPE order_status AS ENUM ('pending', 'processing', 'shipped', 'cancelled', 'refunded');

CREATE TABLE customers (
  id          bigserial PRIMARY KEY,
  email       text        NOT NULL UNIQUE,
  full_name   text        NOT NULL,
  country     char(2),
  is_active   boolean     DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customers_created_at_idx ON customers (created_at);

CREATE TABLE products (
  id        serial PRIMARY KEY,
  sku       text          NOT NULL UNIQUE,
  name      text          NOT NULL,
  price     numeric(8,2)  NOT NULL,
  stock     integer       NOT NULL DEFAULT 0,
  archived  boolean       NOT NULL DEFAULT false
);

CREATE TABLE orders (
  id           bigserial PRIMARY KEY,
  customer_id  bigint        NOT NULL REFERENCES customers (id),
  status       order_status  NOT NULL DEFAULT 'pending',
  total        numeric(10,2) NOT NULL DEFAULT 0.00,
  placed_at    timestamptz   NOT NULL DEFAULT now(),
  shipped_at   timestamptz
);
CREATE INDEX orders_customer_id_idx ON orders (customer_id);
CREATE INDEX orders_placed_at_idx   ON orders (placed_at);
CREATE INDEX orders_status_idx      ON orders (status);
CREATE INDEX orders_shipped_at_idx  ON orders (shipped_at) WHERE shipped_at IS NOT NULL;

CREATE TABLE order_items (
  order_id    bigint       NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  product_id  integer      NOT NULL REFERENCES products (id),
  quantity    integer      NOT NULL CHECK (quantity > 0),
  unit_price  numeric(8,2) NOT NULL,
  PRIMARY KEY (order_id, product_id)
);

CREATE TABLE invoices (
  id         text          PRIMARY KEY,
  order_id   bigint        NOT NULL REFERENCES orders (id),
  amount     numeric(10,2) NOT NULL,
  currency   char(3)       NOT NULL DEFAULT 'USD',
  issued_at  timestamptz   NOT NULL DEFAULT now(),
  paid_at    timestamptz
);
CREATE INDEX invoices_order_id_idx  ON invoices (order_id);
CREATE INDEX invoices_issued_at_idx ON invoices (issued_at);
CREATE INDEX invoices_paid_at_idx   ON invoices (paid_at);

COMMENT ON TABLE customers IS 'People who have placed at least one order or signed up.';
COMMENT ON COLUMN orders.total IS 'Sum of order_items.quantity * unit_price.';

-- ---------------------------------------------------------------- customers
INSERT INTO customers (email, full_name, country, is_active, created_at)
SELECT lower(translate(f, 'ÁÉÍÓÚáéíóúñ', 'AEIOUaeioun')) || '.' || lower(translate(l, 'ÁÉÍÓÚáéíóúñ', 'AEIOUaeioun')) || g || '@example.com',
       f || ' ' || l,
       country, active, created
FROM (
  SELECT g,
         (ARRAY['Sara','Tom','Hannah','Mateo','Priya','Kenji','Lucie','Ada','Liam','Noor','Elena','Jonas',
                'Amara','Diego','Yuki','Freya','Omar','Chloe','Ravi','Ingrid','Malik','Sofia','Arjun','Mia',
                'Lars','Zara','Felix','Leila','Hugo','Aiko','Nina','Kofi','Iris','Pablo','Ana','Wei'])[1 + floor(random() * 36)::int] AS f,
         (ARRAY['Lindqvist','Reid','Berg','Álvarez','Rao','Sato','Martin','Okafor','Murphy','Haddad','Petrova',
                'Schmidt','Mensah','García','Tanaka','Nielsen','Farouk','Dubois','Patel','Larsen','Bakr','Rossi',
                'Iyer','Kowalski','Novak','Chen','Silva','Moreau','Kim','Fischer'])[1 + floor(random() * 30)::int] AS l,
         CASE WHEN random() < 0.04 THEN NULL
              ELSE (ARRAY['US','GB','DE','FR','SE','IN','JP','MX','NG','BR','CA','AU','ES','IT','NL'])[1 + floor(random() * 15)::int]
         END AS country,
         CASE WHEN random() < 0.03 THEN NULL WHEN random() < 0.08 THEN false ELSE true END AS active,
         timestamptz '2026-10-08 12:00:00+00' - (48213 - g) * interval '9 minutes' - random() * interval '8 minutes' AS created
  FROM generate_series(1, 48213) AS g
) s;

-- ---------------------------------------------------------------- products
INSERT INTO products (sku, name, price, stock, archived)
SELECT upper(left(kind, 3)) || '-' || lpad(g::text, 5, '0'),
       adj || ' ' || lower(kind),
       round((4 + random() * 180)::numeric, 2),
       CASE WHEN random() < 0.05 THEN 0 ELSE floor(random() * 500)::int END,
       random() < 0.06
FROM (
  SELECT g,
         (ARRAY['Brass','Wool','Dot-grid','Steel','Canvas','Organic','Stoneware','Linen','Walnut','Recycled',
                'Ceramic','Leather','Bamboo','Copper','Cotton'])[1 + floor(random() * 15)::int] AS adj,
         (ARRAY['Pen','Cap','Notebook','Bottle','Tote','Tee','Mug','Apron','Tray','Scarf','Bowl','Wallet',
                'Lamp','Candle','Planner'])[1 + floor(random() * 15)::int] AS kind
  FROM generate_series(1, 1286) AS g
) s;

-- ---------------------------------------------------------------- orders
INSERT INTO orders (customer_id, status, placed_at, shipped_at)
SELECT customer_id, status, placed_at,
       CASE WHEN status = 'shipped' THEN placed_at + interval '6 hours' + random() * interval '3 days' END
FROM (
  SELECT 1 + floor(random() * 48213)::bigint AS customer_id,
         (CASE WHEN r < 0.62 THEN 'shipped' WHEN r < 0.80 THEN 'processing' WHEN r < 0.91 THEN 'pending'
               WHEN r < 0.97 THEN 'cancelled' ELSE 'refunded' END)::order_status AS status,
         timestamptz '2026-10-08 08:00:00+00' - (312904 - g) * interval '83 seconds' AS placed_at
  FROM (SELECT g, random() AS r FROM generate_series(1, 312904) AS g) x
) s;

-- 1–3 distinct products per order.
INSERT INTO order_items (order_id, product_id, quantity, unit_price)
SELECT o.id, p.id, 1 + floor(random() * 4)::int, p.price
FROM orders o
CROSS JOIN LATERAL (
  SELECT DISTINCT 1 + ((o.id * 7919 + n * 104729) % 1286)::int AS pid
  FROM generate_series(1, 1 + (o.id % 3)::int) AS n
) pick
JOIN products p ON p.id = pick.pid;

UPDATE orders o
SET total = t.total
FROM (SELECT order_id, sum(quantity * unit_price) AS total FROM order_items GROUP BY order_id) t
WHERE t.order_id = o.id;

-- The bulk UPDATE above scattered rows across the heap; put them back in id
-- order so `SELECT * FROM orders LIMIT 100` looks like a real table.
CLUSTER orders USING orders_pkey;

-- ---------------------------------------------------------------- invoices
INSERT INTO invoices (id, order_id, amount, currency, issued_at, paid_at)
SELECT 'INV-' || lpad(row_number() OVER (ORDER BY o.id)::text, 6, '0'),
       o.id, o.total,
       (ARRAY['USD','USD','USD','EUR','EUR','GBP','INR','JPY'])[1 + (o.id % 8)::int],
       o.placed_at + interval '1 minute',
       CASE WHEN o.status IN ('shipped', 'refunded') OR random() < 0.5
            THEN o.placed_at + interval '2 minutes' + random() * interval '2 days' END
FROM orders o
WHERE o.status <> 'cancelled' AND (o.status <> 'pending' OR o.id % 3 <> 0);

-- ---------------------------------------------------------------- views & functions
CREATE MATERIALIZED VIEW daily_revenue AS
SELECT date_trunc('day', placed_at)::date AS day,
       count(*)                           AS orders,
       sum(total)                         AS revenue
FROM orders
WHERE status IN ('processing', 'shipped')
GROUP BY 1
ORDER BY 1 DESC;
CREATE UNIQUE INDEX daily_revenue_day_idx ON daily_revenue (day);

CREATE VIEW low_stock AS
SELECT id, sku, name, stock
FROM products
WHERE NOT archived AND stock < 20
ORDER BY stock, sku;

CREATE FUNCTION refresh_revenue() RETURNS void
LANGUAGE sql AS $$
  REFRESH MATERIALIZED VIEW daily_revenue;
$$;

COMMENT ON FUNCTION refresh_revenue() IS 'Rebuilds the daily_revenue materialized view.';
