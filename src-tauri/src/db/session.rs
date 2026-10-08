//! Live connections to a server.
//!
//! Each connected profile gets two Postgres connections:
//! * `meta` — catalog queries for the explorer. Shared, used concurrently.
//! * `editor` — the user's SQL session. Runs are serialised through a mutex,
//!   and session state (SET, BEGIN, temp tables) persists between runs, the
//!   same as psql.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use postgres_native_tls::MakeTlsConnector;
use serde::Serialize;
use tokio::sync::{Mutex, MutexGuard, RwLock};
use tokio_postgres::{CancelToken, Client};

use super::{SslMode, TxState};
use crate::error::{AppError, AppResult};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone)]
pub struct ConnectParams {
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    pub password: Option<String>,
    pub ssl_mode: SslMode,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    /// e.g. "16.15"
    pub version: String,
    pub encoding: String,
    pub user: String,
    pub database: String,
    pub host: String,
    pub port: u16,
    /// Whether the connection actually negotiated TLS.
    pub ssl: bool,
}

pub struct Editor {
    pub client: Client,
    pub tx: TxState,
}

pub struct Session {
    pub info: ServerInfo,
    params: ConnectParams,
    tls: MakeTlsConnector,
    meta: StdMutex<Arc<Client>>,
    editor: Mutex<Editor>,
    cancel_token: StdMutex<CancelToken>,
    /// Set when the user presses Stop, so the resulting error reads as a cancel.
    pub(crate) cancel_requested: AtomicBool,
}

fn make_tls(mode: SslMode) -> AppResult<MakeTlsConnector> {
    let mut builder = native_tls::TlsConnector::builder();
    match mode {
        // libpq does not verify certificates in these modes.
        SslMode::Disable | SslMode::Prefer | SslMode::Require => {
            builder.danger_accept_invalid_certs(true);
            builder.danger_accept_invalid_hostnames(true);
        }
        SslMode::VerifyCa => {
            builder.danger_accept_invalid_hostnames(true);
        }
        SslMode::VerifyFull => {}
    }
    Ok(MakeTlsConnector::new(builder.build()?))
}

async fn open_client(params: &ConnectParams, tls: &MakeTlsConnector, app_name: &str) -> AppResult<Client> {
    let mut config = tokio_postgres::Config::new();
    config
        .host(&params.host)
        .port(params.port)
        .dbname(&params.database)
        .user(&params.user)
        .application_name(app_name)
        .connect_timeout(CONNECT_TIMEOUT)
        .keepalives(true)
        .ssl_mode(match params.ssl_mode {
            SslMode::Disable => tokio_postgres::config::SslMode::Disable,
            SslMode::Prefer => tokio_postgres::config::SslMode::Prefer,
            SslMode::Require | SslMode::VerifyCa | SslMode::VerifyFull => tokio_postgres::config::SslMode::Require,
        });
    if let Some(password) = params.password.as_deref().filter(|p| !p.is_empty()) {
        config.password(password);
    }

    let connect = config.connect(tls.clone());
    let (client, connection) = tokio::time::timeout(CONNECT_TIMEOUT, connect)
        .await
        .map_err(|_| AppError::new(crate::error::ErrorKind::Connection, format!("Timed out connecting to {}:{}", params.host, params.port)))??;
    // The connection future drives the socket; it ends when the client is dropped.
    tokio::spawn(async move {
        let _ = connection.await;
    });
    Ok(client)
}

async fn set_read_only_default(client: &Client, read_only: bool) -> AppResult<()> {
    let value = if read_only { "on" } else { "off" };
    client.batch_execute(&format!("SET default_transaction_read_only = {value}")).await?;
    Ok(())
}

impl Session {
    pub async fn connect(params: ConnectParams, read_only: bool) -> AppResult<Session> {
        let tls = make_tls(params.ssl_mode)?;
        let (meta, editor) = tokio::try_join!(
            open_client(&params, &tls, "Zusk (explorer)"),
            open_client(&params, &tls, "Zusk"),
        )?;

        let row = meta
            .query_one(
                "SELECT split_part(current_setting('server_version'), ' ', 1),
                        current_setting('server_encoding'),
                        current_user::text,
                        current_database()::text,
                        COALESCE((SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()), false)",
                &[],
            )
            .await?;
        let info = ServerInfo {
            version: row.get(0),
            encoding: row.get(1),
            user: row.get(2),
            database: row.get(3),
            host: params.host.clone(),
            port: params.port,
            ssl: row.get(4),
        };

        set_read_only_default(&editor, read_only).await?;
        let cancel_token = editor.cancel_token();
        Ok(Session {
            info,
            params,
            tls,
            meta: StdMutex::new(Arc::new(meta)),
            editor: Mutex::new(Editor { client: editor, tx: TxState::Idle }),
            cancel_token: StdMutex::new(cancel_token),
            cancel_requested: AtomicBool::new(false),
        })
    }

    /// The catalog connection, reconnecting first if it was dropped.
    pub async fn meta(&self) -> AppResult<Arc<Client>> {
        let current = self.meta.lock().unwrap().clone();
        if !current.is_closed() {
            return Ok(current);
        }
        let fresh = Arc::new(open_client(&self.params, &self.tls, "Zusk (explorer)").await?);
        *self.meta.lock().unwrap() = fresh.clone();
        Ok(fresh)
    }

    /// Exclusive access to the editor connection, reconnecting first if it
    /// was dropped (server restart, network change, idle timeout).
    pub async fn editor(&self, read_only: bool) -> AppResult<MutexGuard<'_, Editor>> {
        let mut editor = self.editor.lock().await;
        if editor.client.is_closed() {
            let client = open_client(&self.params, &self.tls, "Zusk").await?;
            set_read_only_default(&client, read_only).await?;
            *self.cancel_token.lock().unwrap() = client.cancel_token();
            *editor = Editor { client, tx: TxState::Idle };
        }
        Ok(editor)
    }

    /// Switches the editor session between read-only and read-write.
    /// Going read-only rolls back any transaction the user left open.
    pub async fn apply_read_only(&self, read_only: bool) -> AppResult<()> {
        let mut editor = self.editor(read_only).await?;
        if read_only && editor.tx != TxState::Idle {
            editor.client.batch_execute("ROLLBACK").await?;
        }
        editor.tx = TxState::Idle;
        set_read_only_default(&editor.client, read_only).await
    }

    /// Asks the server to cancel whatever the editor connection is running.
    pub(crate) async fn send_cancel(&self) -> AppResult<()> {
        let token = self.cancel_token.lock().unwrap().clone();
        token.cancel_query(self.tls.clone()).await?;
        Ok(())
    }

    pub async fn cancel(&self) -> AppResult<()> {
        self.cancel_requested.store(true, Ordering::SeqCst);
        self.send_cancel().await
    }
}

/// Connected sessions, keyed by connection profile id.
#[derive(Default)]
pub struct Sessions(RwLock<HashMap<String, Arc<Session>>>);

impl Sessions {
    pub async fn get(&self, id: &str) -> AppResult<Arc<Session>> {
        self.0.read().await.get(id).cloned().ok_or_else(AppError::not_connected)
    }

    pub async fn insert(&self, id: &str, session: Session) -> Arc<Session> {
        let session = Arc::new(session);
        self.0.write().await.insert(id.to_owned(), session.clone());
        session
    }

    pub async fn remove(&self, id: &str) -> Option<Arc<Session>> {
        self.0.write().await.remove(id)
    }

    pub async fn all(&self) -> Vec<Arc<Session>> {
        self.0.read().await.values().cloned().collect()
    }
}
