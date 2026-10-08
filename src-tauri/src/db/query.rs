//! Runs SQL from the editor.
//!
//! The script is split into statements and each one is sent with the simple
//! query protocol, the same as psql. That way multi-statement scripts work,
//! and every value comes back as Postgres' own text rendering, so the grid
//! shows exactly what psql would. Column types are filled in afterwards by
//! preparing the statement (no re-execution).
//!
//! Read-only mode is enforced by the server: the run is wrapped in
//! `BEGIN READ ONLY … ROLLBACK`, a snapshot is taken immediately (so the
//! transaction cannot be switched to read-write), and statements that would
//! end the transaction early are refused before anything is sent.

use std::sync::atomic::Ordering;
use std::time::Instant;

use futures_util::{pin_mut, StreamExt};
use serde::Serialize;
use tokio_postgres::error::{ErrorPosition, SqlState};
use tokio_postgres::types::{Kind, Type};
use tokio_postgres::{Client, SimpleQueryMessage};

use super::splitter::{self, Statement, TxEffect};
use super::{Session, TxState};
use crate::error::{AppError, AppResult, ErrorKind};

/// Rows kept per result set. Larger results are cut off (and the UI says so).
pub const MAX_ROWS: usize = 100_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ValueKind {
    Num,
    Bool,
    Date,
    Json,
    Text,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultColumn {
    pub name: String,
    /// Short Postgres type name, e.g. "int8", "timestamptz", "text[]".
    /// Empty when the type could not be determined.
    pub type_name: String,
    pub kind: ValueKind,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    pub columns: Vec<ResultColumn>,
    pub rows: Vec<Vec<Option<String>>>,
    /// True when the shown statement returned a result set (even an empty one).
    pub has_result_set: bool,
    /// True when the result set had more than MAX_ROWS rows.
    pub truncated: bool,
    /// Rows returned or affected by the shown statement. When `truncated`
    /// and equal to `rows.len()`, the real total is unknown (at least this many).
    pub row_count: u64,
    /// Command of the shown statement, e.g. "SELECT" or "UPDATE".
    pub command: String,
    pub statement_count: usize,
    pub elapsed_ms: f64,
    pub transaction: TxState,
}

#[derive(Default)]
struct Output {
    columns: Option<Vec<String>>,
    rows: Vec<Vec<Option<String>>>,
    row_count: u64,
    truncated: bool,
    /// The statement was cancelled at the row cap, which aborts the
    /// surrounding read-only transaction.
    cancelled_at_cap: bool,
}

pub async fn run(session: &Session, sql: &str, read_only: bool) -> AppResult<RunResult> {
    let statements = splitter::split(sql);
    if statements.is_empty() {
        return Err(AppError::invalid("There is no SQL to run."));
    }
    if read_only {
        if let Some((st, word)) = statements.iter().find_map(|s| s.transaction_control().map(|w| (s, w))) {
            let mut err = AppError::new(ErrorKind::ReadOnly, format!("{word} is not allowed in a read-only session."))
                .with_hint("Turn off read-only mode to manage transactions yourself.");
            err.position = Some(utf16_len(&sql[..st.start]));
            err.statement_range = Some(statement_range(sql, st));
            return Err(err);
        }
    }

    let mut editor = session.editor(read_only).await?;
    session.cancel_requested.store(false, Ordering::SeqCst);
    let started = Instant::now();

    if read_only {
        // `SELECT 1` takes the first snapshot, after which Postgres refuses
        // `SET TRANSACTION READ WRITE` for the rest of the transaction.
        editor.client.batch_execute("BEGIN TRANSACTION READ ONLY; SELECT 1").await?;
        editor.tx = TxState::InTransaction;
    }

    let mut shown: Option<(Output, &Statement)> = None;
    let mut last: Option<(Output, &Statement)> = None;
    let mut failure: Option<AppError> = None;

    for (index, st) in statements.iter().enumerate() {
        let text = st.text(sql);
        // Hitting the row cap cancels the statement instead of streaming the
        // rest — only safe when nothing else runs after it and the transaction
        // is ours to throw away.
        let cancel_on_cap = read_only && index + 1 == statements.len();
        match execute(session, &editor.client, text, cancel_on_cap).await {
            Ok(output) => {
                if !read_only {
                    editor.tx = next_tx_state(editor.tx, st);
                }
                if output.columns.is_some() {
                    shown = Some((output, st));
                } else {
                    last = Some((output, st));
                }
            }
            Err(err) => {
                if !read_only {
                    editor.tx = match (editor.tx, st.tx_effect()) {
                        (_, TxEffect::End) => TxState::Idle,
                        (TxState::InTransaction | TxState::Failed, _) => TxState::Failed,
                        _ => TxState::Idle,
                    };
                }
                failure = Some(map_error(session, err, sql, st));
                break;
            }
        }
    }

    // Look up column types while still inside the (read-only) transaction,
    // so statements that use objects created earlier in the script describe.
    // A cap-cancelled statement has aborted that transaction, so it is
    // described after the rollback instead.
    let to_describe = shown.as_ref().filter(|_| failure.is_none()).map(|(out, st)| (st.text(sql), out.cancelled_at_cap));
    let mut types = None;
    if let Some((text, false)) = to_describe {
        types = describe(&editor.client, text, editor.tx != TxState::Idle).await;
    }

    if read_only {
        let _ = editor.client.batch_execute("ROLLBACK").await;
        editor.tx = TxState::Idle;
    }
    if let Some((text, true)) = to_describe {
        types = describe(&editor.client, text, false).await;
    }
    let transaction = if read_only { TxState::ReadOnly } else { editor.tx };
    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;

    if let Some(mut err) = failure {
        err.elapsed_ms = Some(elapsed_ms);
        err.transaction = Some(transaction);
        return Err(err);
    }

    let (output, st) = shown.or(last).expect("at least one statement ran");
    let columns = output
        .columns
        .as_ref()
        .map(|names| {
            names
                .iter()
                .enumerate()
                .map(|(i, name)| {
                    let ty = types.as_ref().filter(|t| t.len() == names.len()).map(|t| &t[i]);
                    ResultColumn {
                        name: name.clone(),
                        type_name: ty.map(type_label).unwrap_or_default(),
                        kind: ty.map(value_kind).unwrap_or(ValueKind::Text),
                    }
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(RunResult {
        columns,
        has_result_set: output.columns.is_some(),
        // When the cap cancelled the statement the true total is unknown, so
        // report what was kept (the UI shows "100,000+").
        row_count: if output.cancelled_at_cap { output.rows.len() as u64 } else { output.row_count.max(output.rows.len() as u64) },
        truncated: output.truncated,
        rows: output.rows,
        command: st.command(),
        statement_count: statements.len(),
        elapsed_ms,
        transaction,
    })
}

async fn execute(session: &Session, client: &Client, text: &str, cancel_on_cap: bool) -> Result<Output, tokio_postgres::Error> {
    let stream = client.simple_query_raw(text).await?;
    pin_mut!(stream);
    let mut out = Output::default();
    let mut cap_cancelled = false;

    while let Some(message) = stream.next().await {
        let message = match message {
            Ok(m) => m,
            Err(e) if cap_cancelled && e.code() == Some(&SqlState::QUERY_CANCELED) => {
                out.cancelled_at_cap = true;
                break;
            }
            Err(e) => return Err(e),
        };
        match message {
            SimpleQueryMessage::RowDescription(columns) => {
                // A new result set (only one per statement, but be safe).
                out = Output {
                    columns: Some(columns.iter().map(|c| c.name().to_owned()).collect()),
                    ..Output::default()
                };
            }
            SimpleQueryMessage::Row(row) => {
                if out.rows.len() < MAX_ROWS {
                    out.rows.push((0..row.len()).map(|i| row.get(i).map(str::to_owned)).collect());
                } else {
                    out.truncated = true;
                    if cancel_on_cap && !cap_cancelled {
                        cap_cancelled = true;
                        // Awaited, so the signal reaches the server before any
                        // later command is sent on this connection.
                        let _ = session.send_cancel().await;
                    }
                }
                out.row_count += 1;
            }
            SimpleQueryMessage::CommandComplete(n) => out.row_count = n,
            _ => {}
        }
    }
    Ok(out)
}

/// Resolves the result column types of `text` by preparing it (Parse +
/// Describe, no execution). Inside a transaction the prepare runs under a
/// savepoint, so a failure can never abort the user's transaction; the three
/// messages are pipelined into a single round trip.
async fn describe(client: &Client, text: &str, in_transaction: bool) -> Option<Vec<Type>> {
    let prepared = if in_transaction {
        let (_, prepared, _) = tokio::join!(
            client.batch_execute("SAVEPOINT zusk_describe"),
            client.prepare(text),
            client.batch_execute("ROLLBACK TO SAVEPOINT zusk_describe; RELEASE SAVEPOINT zusk_describe"),
        );
        prepared
    } else {
        client.prepare(text).await
    };
    prepared.ok().map(|st| st.columns().iter().map(|c| c.type_().clone()).collect())
}

fn next_tx_state(state: TxState, st: &Statement) -> TxState {
    match st.tx_effect() {
        TxEffect::Begin => TxState::InTransaction,
        TxEffect::End => TxState::Idle,
        TxEffect::RollbackToSavepoint if state == TxState::Failed => TxState::InTransaction,
        _ => state,
    }
}

fn map_error(session: &Session, err: tokio_postgres::Error, sql: &str, st: &Statement) -> AppError {
    if err.code() == Some(&SqlState::QUERY_CANCELED) && session.cancel_requested.load(Ordering::SeqCst) {
        let mut out = AppError::new(ErrorKind::Cancelled, "Query cancelled.");
        out.statement_range = Some(statement_range(sql, st));
        return out;
    }
    let position = err.as_db_error().and_then(|db| match db.position() {
        Some(ErrorPosition::Original(p)) => Some(*p as usize),
        _ => None,
    });
    let mut out = AppError::from(err);
    if out.kind == ErrorKind::Database {
        out.statement_range = Some(statement_range(sql, st));
        // Postgres positions are 1-based character offsets into the
        // statement; the editor wants 0-based UTF-16 offsets into the script.
        out.position = position.map(|p| {
            let before = utf16_len(&sql[..st.start]);
            let within: usize = st.text(sql).chars().take(p.saturating_sub(1)).map(char::len_utf16).sum();
            before + within
        });
    }
    out
}

fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

fn statement_range(sql: &str, st: &Statement) -> (usize, usize) {
    let from = utf16_len(&sql[..st.start]);
    (from, from + utf16_len(st.text(sql)))
}

/// "int8", "timestamptz", "text[]", "order_status", …
pub fn type_label(ty: &Type) -> String {
    match ty.kind() {
        Kind::Array(inner) => format!("{}[]", type_label(inner)),
        _ => match ty.name() {
            "bpchar" => "char".to_owned(),
            name => name.to_owned(),
        },
    }
}

pub fn value_kind(ty: &Type) -> ValueKind {
    match ty.kind() {
        Kind::Domain(base) => value_kind(base),
        Kind::Simple => match ty.name() {
            "int2" | "int4" | "int8" | "float4" | "float8" | "numeric" | "oid" | "money" => ValueKind::Num,
            "bool" => ValueKind::Bool,
            "date" | "time" | "timetz" | "timestamp" | "timestamptz" | "interval" => ValueKind::Date,
            "json" | "jsonb" => ValueKind::Json,
            _ => ValueKind::Text,
        },
        _ => ValueKind::Text,
    }
}
