use serde::Serialize;

/// The single error type returned to the UI by every command.
///
/// Database errors keep Postgres' own message, detail, hint and SQLSTATE code.
/// `position` is a UTF-16 offset into the SQL text that was run, so the editor
/// can underline it directly.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub kind: ErrorKind,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<usize>,
    /// UTF-16 range of the statement that failed, when the error came from a
    /// run, or of the template tag that failed to render.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub statement_range: Option<(usize, usize)>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub elapsed_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transaction: Option<crate::db::TxState>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    /// Postgres rejected a statement.
    Database,
    /// Could not reach or talk to the server.
    Connection,
    /// The connection id is not connected.
    NotConnected,
    /// The statement was refused because the session is read-only.
    ReadOnly,
    /// The user cancelled the running query.
    Cancelled,
    /// OS keychain failure.
    Keychain,
    /// Saving or loading connection profiles failed.
    Config,
    /// Bad input from the UI.
    Invalid,
    /// The AI provider failed or returned something unusable.
    Ai,
    /// The editor's Jinja template failed to render.
    Template,
}

impl AppError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        AppError {
            kind,
            message: message.into(),
            detail: None,
            hint: None,
            code: None,
            position: None,
            statement_range: None,
            elapsed_ms: None,
            transaction: None,
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Invalid, message)
    }

    pub fn not_connected() -> Self {
        Self::new(ErrorKind::NotConnected, "Not connected. Connect from the explorer first.")
    }

    pub fn with_hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for AppError {}

impl From<tokio_postgres::Error> for AppError {
    fn from(err: tokio_postgres::Error) -> Self {
        if let Some(db) = err.as_db_error() {
            let mut out = AppError::new(ErrorKind::Database, db.message());
            out.detail = db.detail().map(str::to_owned);
            out.hint = db.hint().map(str::to_owned);
            out.code = Some(db.code().code().to_owned());
            return out;
        }
        // tokio-postgres keeps the useful part ("Connection refused", TLS
        // failures, …) in the source chain, so flatten it into the message.
        let mut message = err.to_string();
        let mut source = std::error::Error::source(&err);
        while let Some(cause) = source {
            let text = cause.to_string();
            if !message.contains(&text) {
                message.push_str(": ");
                message.push_str(&text);
            }
            source = cause.source();
        }
        if message.contains("password missing") {
            return AppError::new(ErrorKind::Connection, "The server asked for a password, but none is saved for this connection.")
                .with_hint("Edit the connection and enter the password.");
        }
        AppError::new(ErrorKind::Connection, message)
    }
}

impl From<keyring::Error> for AppError {
    fn from(err: keyring::Error) -> Self {
        AppError::new(ErrorKind::Keychain, format!("Keychain error: {err}"))
    }
}

impl From<native_tls::Error> for AppError {
    fn from(err: native_tls::Error) -> Self {
        AppError::new(ErrorKind::Connection, format!("TLS setup failed: {err}"))
    }
}

impl From<reqwest::Error> for AppError {
    fn from(err: reqwest::Error) -> Self {
        let message = if err.is_timeout() {
            "The AI provider took too long to answer.".to_owned()
        } else if err.is_connect() {
            // The URL is the useful part ("connection refused" to localhost:11434, …).
            let url = err.url().map(|u| format!(" at {}", u.origin().ascii_serialization())).unwrap_or_default();
            format!("Could not reach the AI provider{url}.")
        } else {
            let mut message = format!("AI request failed: {err}");
            let mut source = std::error::Error::source(&err);
            while let Some(cause) = source {
                message.push_str(&format!(": {cause}"));
                source = cause.source();
            }
            message
        };
        AppError::new(ErrorKind::Ai, message)
    }
}

pub type AppResult<T> = Result<T, AppError>;
