//! Everything that talks to PostgreSQL.

pub mod catalog;
pub mod query;
pub mod session;
pub mod splitter;

use serde::{Deserialize, Serialize};

pub use session::{ConnectParams, ServerInfo, Session, Sessions};

/// SSL modes with libpq semantics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SslMode {
    /// Plain TCP only.
    Disable,
    /// Try TLS without verifying the certificate, fall back to plain TCP.
    #[default]
    Prefer,
    /// TLS required; the certificate is not verified.
    Require,
    /// TLS required; the certificate chain must be trusted by the OS.
    VerifyCa,
    /// As verify-ca, and the certificate must match the host name.
    VerifyFull,
}

/// Transaction state of the editor session, shown in the status bar.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TxState {
    /// Read-only mode: every run is wrapped in its own read-only
    /// transaction that is rolled back afterwards.
    ReadOnly,
    /// Auto-commit: no transaction open between runs.
    Idle,
    /// The user opened a transaction (BEGIN) that is still open.
    InTransaction,
    /// The user's transaction hit an error and needs a ROLLBACK.
    Failed,
}
