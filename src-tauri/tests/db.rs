//! Integration tests against the docker-compose seed database.
//!
//!   docker compose up -d --wait
//!   cargo test --manifest-path src-tauri/Cargo.toml -- --include-ignored
//!
//! Set ZUSK_TEST_PORT if the database is not on 54329.

use std::time::{Duration, Instant};

use zusk_lib::db::catalog::{self, RelationKind};
use zusk_lib::db::query::{self, ValueKind, MAX_ROWS};
use zusk_lib::db::{ConnectParams, Session, SslMode, TxState};
use zusk_lib::error::ErrorKind;

fn params(database: &str, ssl_mode: SslMode) -> ConnectParams {
    ConnectParams {
        host: "localhost".into(),
        port: std::env::var("ZUSK_TEST_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(54329),
        database: database.into(),
        user: "studio".into(),
        password: Some("studio".into()),
        ssl_mode,
    }
}

async fn session() -> Session {
    Session::connect(params("shop_dev", SslMode::Prefer), true).await.expect("seed database is running")
}

const NEEDS_DB: &str = "needs `docker compose up -d`";

#[tokio::test]
#[ignore = "needs `docker compose up -d`"]
async fn connects_with_each_ssl_mode() {
    let _ = NEEDS_DB;
    let prefer = Session::connect(params("shop_dev", SslMode::Prefer), true).await.unwrap();
    assert!(prefer.info.ssl);
    assert!(prefer.info.version.starts_with("16."));
    assert_eq!(prefer.info.database, "shop_dev");
    assert_eq!(prefer.info.encoding, "UTF8");

    assert!(Session::connect(params("shop_dev", SslMode::Require), true).await.unwrap().info.ssl);
    assert!(!Session::connect(params("shop_dev", SslMode::Disable), true).await.unwrap().info.ssl);

    // The dev certificate is self-signed, so verification must fail.
    let err = Session::connect(params("shop_dev", SslMode::VerifyFull), true).await.err().unwrap();
    assert_eq!(err.kind, ErrorKind::Connection);
}

#[tokio::test]
#[ignore = "needs `docker compose up -d`"]
async fn reports_bad_credentials_and_unreachable_hosts() {
    let mut p = params("shop_dev", SslMode::Prefer);
    p.password = Some("wrong".into());
    let err = Session::connect(p, true).await.err().unwrap();
    assert!(err.message.contains("password authentication failed"), "{}", err.message);

    let mut p = params("shop_dev", SslMode::Prefer);
    p.password = None;
    let err = Session::connect(p, true).await.err().unwrap();
    assert!(err.message.contains("none is saved"), "{}", err.message);

    let mut p = params("shop_dev", SslMode::Disable);
    p.port = 1;
    let err = Session::connect(p, true).await.err().unwrap();
    assert_eq!(err.kind, ErrorKind::Connection);
    assert!(err.message.to_lowercase().contains("refused"), "{}", err.message);
}

#[tokio::test]
#[ignore = "needs `docker compose up -d`"]
async fn loads_the_catalog() {
    let s = session().await;
    let meta = s.meta().await.unwrap();

    let schemas = catalog::list_schemas(&meta).await.unwrap();
    let names: Vec<_> = schemas.iter().map(|s| (s.name.as_str(), s.relation_count)).collect();
    assert_eq!(names, vec![("public", 7), ("analytics", 2), ("playground", 2)]);

    let public = catalog::list_schema_objects(&meta, "public").await.unwrap();
    let tables: Vec<_> = public.tables.iter().map(|t| t.name.as_str()).collect();
    assert_eq!(tables, vec!["customers", "invoices", "order_items", "orders", "products"]);
    let customers = &public.tables[0];
    assert_eq!(customers.row_estimate, Some(48213));
    assert!(customers.size_bytes.unwrap() > 0);
    let views: Vec<_> = public.views.iter().map(|v| (v.name.as_str(), v.kind)).collect();
    assert_eq!(views, vec![("daily_revenue", RelationKind::MaterializedView), ("low_stock", RelationKind::View)]);
    assert_eq!(public.functions.len(), 1);
    assert_eq!(public.functions[0].name, "refresh_revenue");

    let playground = catalog::list_schema_objects(&meta, "playground").await.unwrap();
    let routines: Vec<_> = playground.functions.iter().map(|f| (f.name.as_str(), f.arguments.as_str(), f.is_procedure)).collect();
    assert_eq!(
        routines,
        vec![("bump_stock", "IN p_product integer, IN p_by integer", true), ("customer_count", "p_country character", false)]
    );

    let def = catalog::function_definition(&meta, public.functions[0].oid).await.unwrap();
    assert!(def.contains("REFRESH MATERIALIZED VIEW daily_revenue"));

    let relations = catalog::list_relations(&meta).await.unwrap();
    assert!(relations.iter().any(|r| r.schema == "analytics" && r.name == "events"));
}

#[tokio::test]
#[ignore = "needs `docker compose up -d`"]
async fn describes_tables_with_keys_and_defaults() {
    let s = session().await;
    let meta = s.meta().await.unwrap();

    let orders = catalog::describe_table(&meta, "public", "orders").await.unwrap();
    assert_eq!(orders.index_count, 5);
    let cols: Vec<_> = orders.columns.iter().map(|c| (c.name.as_str(), c.data_type.as_str())).collect();
    assert_eq!(
        cols,
        vec![
            ("id", "int8"),
            ("customer_id", "int8"),
            ("status", "order_status"),
            ("total", "numeric(10,2)"),
            ("placed_at", "timestamptz"),
            ("shipped_at", "timestamptz"),
        ]
    );
    let id = &orders.columns[0];
    assert!(id.is_primary_key && !id.nullable);
    assert_eq!(id.default_value.as_deref(), Some("nextval('orders_id_seq'::regclass)"));
    let customer_id = &orders.columns[1];
    assert!(customer_id.is_foreign_key);
    assert_eq!(customer_id.references.as_deref(), Some("public.customers(id)"));
    assert!(orders.columns[5].nullable);

    let items = catalog::describe_table(&meta, "public", "order_items").await.unwrap();
    assert!(items.columns[0].is_primary_key && items.columns[0].is_foreign_key);
    assert_eq!(items.columns[1].references.as_deref(), Some("public.products(id)"));

    let customers = catalog::describe_table(&meta, "public", "customers").await.unwrap();
    assert!(customers.columns.iter().find(|c| c.name == "email").unwrap().is_unique);
    assert_eq!(customers.columns.iter().find(|c| c.name == "country").unwrap().data_type, "char(2)");

    let samples = catalog::describe_table(&meta, "playground", "type_samples").await.unwrap();
    let id = &samples.columns[0];
    assert_eq!(id.identity.as_deref(), Some("always"));
    let doubled = samples.columns.iter().find(|c| c.name == "doubled").unwrap();
    assert_eq!(doubled.generated.as_deref(), Some("(big_int * 2)"));
    assert_eq!(doubled.default_value, None);
    assert_eq!(samples.columns.iter().find(|c| c.name == "label").unwrap().data_type, "varchar(40)");

    let missing = catalog::describe_table(&meta, "public", "nope").await.err().unwrap();
    assert_eq!(missing.kind, ErrorKind::Invalid);
}

#[tokio::test]
#[ignore = "needs `docker compose up -d`"]
async fn returns_typed_text_results() {
    let s = session().await;
    let r = query::run(&s, "SELECT id, email, is_active, created_at, country FROM customers ORDER BY id LIMIT 3", true)
        .await
        .unwrap();
    let cols: Vec<_> = r.columns.iter().map(|c| (c.name.as_str(), c.type_name.as_str(), c.kind)).collect();
    assert_eq!(
        cols,
        vec![
            ("id", "int8", ValueKind::Num),
            ("email", "text", ValueKind::Text),
            ("is_active", "bool", ValueKind::Bool),
            ("created_at", "timestamptz", ValueKind::Date),
            ("country", "char", ValueKind::Text),
        ]
    );
    assert_eq!(r.rows.len(), 3);
    assert_eq!(r.row_count, 3);
    assert_eq!(r.rows[0][0].as_deref(), Some("1"));
    assert!(matches!(r.rows[0][2].as_deref(), Some("t") | Some("f") | None));
    assert_eq!(r.command, "SELECT");
    assert_eq!(r.transaction, TxState::ReadOnly);
    assert!(r.has_result_set && !r.truncated);
}

#[tokio::test]
#[ignore = "needs `docker compose up -d`"]
async fn handles_enums_domains_arrays_and_nulls() {
    let s = session().await;
    let r = query::run(&s, "SELECT o.status, t.tags, t.contact, t.payload, t.notes FROM orders o, playground.type_samples t WHERE t.id = 4 LIMIT 1", true)
        .await
        .unwrap();
    let cols: Vec<_> = r.columns.iter().map(|c| (c.type_name.as_str(), c.kind)).collect();
    assert_eq!(
        cols,
        vec![
            ("order_status", ValueKind::Text),
            ("text[]", ValueKind::Text),
            // Postgres describes domain-typed result columns by their base type.
            ("text", ValueKind::Text),
            ("jsonb", ValueKind::Json),
            ("text", ValueKind::Text),
        ]
    );
    assert_eq!(r.rows[0][4], None, "notes is NULL for every 4th row");
    assert_eq!(r.rows[0][1].as_deref(), Some("{red,green}"));
}

#[tokio::test]
#[ignore = "needs `docker compose up -d`"]
async fn keeps_columns_for_empty_results() {
    let s = session().await;
    let r = query::run(&s, "SELECT * FROM customers WHERE false", true).await.unwrap();
    assert!(r.has_result_set);
    assert_eq!(r.columns.len(), 6);
    assert_eq!(r.columns[5].type_name, "timestamptz");
    assert!(r.rows.is_empty());
}

#[tokio::test]
#[ignore = "needs `docker compose up -d`"]
async fn shows_the_last_result_set_of_a_script() {
    let s = session().await;
    let r = query::run(&s, "SELECT 1 AS a; SELECT 'two' AS b; SET LOCAL work_mem = '8MB'", true).await.unwrap();
    assert_eq!(r.statement_count, 3);
    assert_eq!(r.columns[0].name, "b");
    assert_eq!(r.rows[0][0].as_deref(), Some("two"));
}

#[tokio::test]
#[ignore = "needs `docker compose up -d`"]
async fn maps_error_positions_into_the_script() {
    let s = session().await;
    let sql = "SELECT 1;\n-- 😀 emoji before\nSELECT * FROM nope";
    let err = query::run(&s, sql, true).await.err().unwrap();
    assert_eq!(err.kind, ErrorKind::Database);
    assert_eq!(err.code.as_deref(), Some("42P01"));
    assert_eq!(err.message, "relation \"nope\" does not exist");
    let utf16: Vec<u16> = sql.encode_utf16().collect();
    let pos = err.position.unwrap();
    assert_eq!(String::from_utf16(&utf16[pos..pos + 4]).unwrap(), "nope");
    let (from, to) = err.statement_range.unwrap();
    assert_eq!(String::from_utf16(&utf16[from..to]).unwrap(), "SELECT * FROM nope");
    assert_eq!(err.transaction, Some(TxState::ReadOnly));
}

#[tokio::test]
#[ignore = "needs `docker compose up -d`"]
async fn read_only_mode_cannot_write() {
    let s = session().await;
    let before = query::run(&s, "SELECT stock FROM products WHERE id = 1", true).await.unwrap().rows[0][0].clone();

    // Plain writes are rejected by the server.
    let err = query::run(&s, "UPDATE products SET stock = stock + 1 WHERE id = 1", true).await.err().unwrap();
    assert_eq!(err.code.as_deref(), Some("25006"), "{}", err.message);

    // Ending the read-only transaction early is refused before anything runs.
    let sql = "SELECT 1; COMMIT; UPDATE products SET stock = 0 WHERE id = 1";
    let err = query::run(&s, sql, true).await.err().unwrap();
    assert_eq!(err.kind, ErrorKind::ReadOnly);
    assert_eq!(&sql[err.position.unwrap()..][..6], "COMMIT");
    for sql in ["end", "rollback; delete from products", "begin", "start transaction", "abort", "prepare transaction 'x'"] {
        assert_eq!(query::run(&s, sql, true).await.err().unwrap().kind, ErrorKind::ReadOnly, "{sql}");
    }

    // The transaction cannot be switched to read-write …
    let err = query::run(&s, "SET TRANSACTION READ WRITE; UPDATE products SET stock = 0 WHERE id = 1", true).await.err().unwrap();
    assert_eq!(err.kind, ErrorKind::Database, "{}", err.message);
    // … nor can the session default be flipped for later statements.
    let err = query::run(
        &s,
        "SELECT set_config('default_transaction_read_only', 'off', false); UPDATE products SET stock = 0 WHERE id = 1",
        true,
    )
    .await
    .err()
    .unwrap();
    assert_eq!(err.code.as_deref(), Some("25006"));
    let err = query::run(&s, "DO $$ BEGIN UPDATE products SET stock = 0 WHERE id = 1; END $$", true).await.err().unwrap();
    assert_eq!(err.code.as_deref(), Some("25006"));
    let err = query::run(&s, "CALL playground.bump_stock(1, 5)", true).await.err().unwrap();
    assert_eq!(err.code.as_deref(), Some("25006"));
    let err = query::run(&s, "SELECT nextval('orders_id_seq')", true).await.err().unwrap();
    assert_eq!(err.code.as_deref(), Some("25006"));

    let after = query::run(&s, "SELECT stock FROM products WHERE id = 1", true).await.unwrap().rows[0][0].clone();
    assert_eq!(before, after);
    // ROLLBACK TO SAVEPOINT is still fine.
    query::run(&s, "SAVEPOINT a; SELECT 1; ROLLBACK TO SAVEPOINT a", true).await.unwrap();
}

#[tokio::test]
#[ignore = "needs `docker compose up -d`"]
async fn write_mode_tracks_transactions() {
    let s = session().await;
    s.apply_read_only(false).await.unwrap();

    let r = query::run(&s, "BEGIN; UPDATE products SET stock = stock WHERE id = 1", false).await.unwrap();
    assert_eq!(r.transaction, TxState::InTransaction);
    assert_eq!(r.command, "UPDATE");
    assert_eq!(r.row_count, 1);
    assert!(!r.has_result_set);

    // A SELECT inside the transaction still gets its types (via a savepoint)
    // and does not disturb the transaction.
    let r = query::run(&s, "SELECT id, price FROM products WHERE id = 1", false).await.unwrap();
    assert_eq!(r.columns[1].type_name, "numeric");
    assert_eq!(r.transaction, TxState::InTransaction);

    let err = query::run(&s, "SELECT 1/0", false).await.err().unwrap();
    assert_eq!(err.code.as_deref(), Some("22012"));
    assert_eq!(err.transaction, Some(TxState::Failed));
    let r = query::run(&s, "ROLLBACK", false).await.unwrap();
    assert_eq!(r.transaction, TxState::Idle);

    let r = query::run(&s, "SELECT 1", false).await.unwrap();
    assert_eq!(r.transaction, TxState::Idle);

    // Going read-only again rolls back anything left open.
    query::run(&s, "BEGIN", false).await.unwrap();
    s.apply_read_only(true).await.unwrap();
    let err = query::run(&s, "UPDATE products SET stock = stock WHERE id = 1", true).await.err().unwrap();
    assert_eq!(err.code.as_deref(), Some("25006"));
}

#[tokio::test]
#[ignore = "needs `docker compose up -d`"]
async fn caps_large_results() {
    let s = session().await;
    let started = Instant::now();
    let r = query::run(&s, "SELECT * FROM analytics.events", true).await.unwrap();
    assert!(r.truncated);
    assert_eq!(r.rows.len(), MAX_ROWS);
    assert_eq!(r.row_count, MAX_ROWS as u64, "total is unknown after a cap cancel");
    assert_eq!(r.columns[3].kind, ValueKind::Json);
    println!("read-only capped run: {:?}", started.elapsed());

    // In write mode the rest is drained instead of cancelled, and counted.
    s.apply_read_only(false).await.unwrap();
    let r = query::run(&s, "SELECT * FROM analytics.events", false).await.unwrap();
    assert!(r.truncated);
    assert_eq!(r.row_count, 500_000);
    assert_eq!(r.rows.len(), MAX_ROWS);
    s.apply_read_only(true).await.unwrap();
    // The connection is still healthy afterwards.
    assert_eq!(query::run(&s, "SELECT 42", true).await.unwrap().rows[0][0].as_deref(), Some("42"));
}

#[tokio::test]
#[ignore = "needs `docker compose up -d`"]
async fn cancels_running_queries() {
    let s = std::sync::Arc::new(session().await);
    let runner = s.clone();
    let started = Instant::now();
    let handle = tokio::spawn(async move { query::run(&runner, "SELECT pg_sleep(10)", true).await });
    tokio::time::sleep(Duration::from_millis(300)).await;
    s.cancel().await.unwrap();
    let err = handle.await.unwrap().err().unwrap();
    assert_eq!(err.kind, ErrorKind::Cancelled);
    assert!(started.elapsed() < Duration::from_secs(3));
    assert!(query::run(&s, "SELECT 1", true).await.is_ok());
}

#[tokio::test]
#[ignore = "needs `docker compose up -d`"]
async fn reconnects_after_the_editor_connection_dies() {
    let s = session().await;
    let pid = query::run(&s, "SELECT pg_backend_pid()", true).await.unwrap().rows[0][0].clone().unwrap();
    s.meta().await.unwrap().execute(&format!("SELECT pg_terminate_backend({pid})"), &[]).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let r = query::run(&s, "SELECT pg_backend_pid()", true).await.unwrap();
    assert_ne!(r.rows[0][0].as_deref(), Some(pid.as_str()));
}

#[tokio::test]
#[ignore = "needs `docker compose up -d`"]
async fn agent_queries_never_write_and_leave_the_editor_alone() {
    // Writes are on, and the user has a transaction open in the editor.
    let s = session().await;
    s.apply_read_only(false).await.unwrap();
    query::run(&s, "BEGIN; UPDATE products SET stock = stock WHERE id = 1", false).await.unwrap();
    let before = query::run_agent(&s, "SELECT stock FROM products WHERE id = 1", 10).await.unwrap().rows[0][0].clone();

    // The server refuses writes hidden in reading statements …
    for sql in [
        "WITH d AS (UPDATE products SET stock = 0 WHERE id = 1 RETURNING id) SELECT * FROM d",
        "SELECT * FROM products WHERE id = 1 FOR UPDATE",
        "SELECT nextval('orders_id_seq')",
        "SELECT * INTO scratch FROM products",
        "EXPLAIN ANALYZE UPDATE products SET stock = 0 WHERE id = 1",
    ] {
        let err = query::run_agent(&s, sql, 10).await.err().unwrap();
        assert_eq!(err.code.as_deref(), Some("25006"), "{sql}: {}", err.message);
    }
    // … and the rest never reaches it.
    for sql in ["UPDATE products SET stock = 0", "COMMIT", "SET default_transaction_read_only = off", "SELECT set_config('x.y', '1', false)"] {
        assert_eq!(query::run_agent(&s, sql, 10).await.err().unwrap().kind, ErrorKind::ReadOnly, "{sql}");
    }

    // Its own connection, read-only with a timeout.
    let r = query::run_agent(
        &s,
        "SELECT application_name, current_setting('default_transaction_read_only'), current_setting('statement_timeout')
         FROM pg_stat_activity WHERE pid = pg_backend_pid()",
        10,
    )
    .await
    .unwrap();
    assert_eq!(r.rows[0], [Some("Zusk (agent)".to_owned()), Some("on".to_owned()), Some("30s".to_owned())]);
    assert_eq!(r.transaction, TxState::ReadOnly);

    let r = query::run_agent(&s, "SELECT id, price FROM products ORDER BY id LIMIT 3", 10).await.unwrap();
    assert_eq!(r.rows.len(), 3);
    assert_eq!(r.columns[1].type_name, "numeric");

    // The user's transaction is still open and unharmed.
    let r = query::run(&s, "SELECT 1", false).await.unwrap();
    assert_eq!(r.transaction, TxState::InTransaction);
    query::run(&s, "ROLLBACK", false).await.unwrap();
    let after = query::run_agent(&s, "SELECT stock FROM products WHERE id = 1", 10).await.unwrap().rows[0][0].clone();
    assert_eq!(before, after);
}

#[tokio::test]
#[ignore = "needs `docker compose up -d`"]
async fn caps_and_cancels_agent_queries() {
    let s = std::sync::Arc::new(session().await);
    let started = Instant::now();
    let r = query::run_agent(&s, "SELECT * FROM analytics.events", 200).await.unwrap();
    assert!(r.truncated);
    assert_eq!(r.rows.len(), 200);
    assert!(started.elapsed() < Duration::from_secs(5), "cancelled at the cap, not drained");
    assert_eq!(query::run_agent(&s, "SELECT 42", 10).await.unwrap().rows[0][0].as_deref(), Some("42"));

    let runner = s.clone();
    let handle = tokio::spawn(async move { query::run_agent(&runner, "SELECT count(*) FROM generate_series(1, 2000000000)", 10).await });
    tokio::time::sleep(Duration::from_millis(300)).await;
    s.cancel_agent().await.unwrap();
    let err = handle.await.unwrap().err().unwrap();
    assert_eq!(err.code.as_deref(), Some("57014"), "{}", err.message);
    // Stopping the agent leaves the editor connection alone, and the agent's recovers.
    assert!(query::run(&s, "SELECT 1", true).await.is_ok());
    assert!(query::run_agent(&s, "SELECT 1", 10).await.is_ok());
}

#[tokio::test]
#[ignore = "needs `docker compose up -d`"]
async fn searches_names_and_lists_table_links() {
    let s = session().await;
    let client = s.meta().await.unwrap();
    let matches = catalog::search_names(&client, "custom", 100).await.unwrap();
    assert!(matches.iter().any(|m| m.table == "customers" && m.column.is_none()), "{matches:?}");
    assert!(matches.iter().any(|m| m.column.as_deref() == Some("customer_id")));
    // LIKE wildcards in the search are literal.
    assert!(catalog::search_names(&client, "%", 100).await.unwrap().is_empty());

    let links = catalog::table_links(&client, "public", "customers").await.unwrap();
    assert!(links.indexes.iter().any(|i| i.contains("UNIQUE INDEX")), "{links:?}");
    assert!(links.referenced_by.iter().any(|r| r.contains("orders") && r.contains("REFERENCES")), "{links:?}");
}
