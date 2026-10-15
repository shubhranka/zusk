//! AI providers and "Fix with AI". Three wire formats cover everything:
//! OpenAI's Chat Completions (OpenAI, OpenRouter, Ollama, LM Studio, …),
//! Anthropic's Messages API and Google's Gemini generateContent.
//!
//! Provider, base URL and model are saved as JSON next to the connection
//! profiles. The API key lives in the OS keychain (see `secrets`), and every
//! call is made from here, so the key never reaches the webview.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio_postgres::Client;

use crate::db::catalog::{self, TableDetails};
use crate::error::{AppError, AppResult, ErrorKind};
use crate::profiles::write_json_atomic;

const KEY_HINT: &str = "Check the API key in Settings → AI.";
const MAX_TOKENS: u32 = 2048;
/// Tables whose columns are sent along with a fix.
const MAX_DESCRIBED: usize = 10;
/// Table and view names listed so the model can correct a misspelled one.
const MAX_LISTED: usize = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiProvider {
    /// Any server that speaks OpenAI's Chat Completions API.
    OpenAi,
    Anthropic,
    Gemini,
}

impl AiProvider {
    /// Keychain account for this provider's API key.
    pub fn key_account(self) -> &'static str {
        match self {
            AiProvider::OpenAi => "ai:openai",
            AiProvider::Anthropic => "ai:anthropic",
            AiProvider::Gemini => "ai:gemini",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiSettings {
    pub provider: AiProvider,
    pub base_url: String,
    pub model: String,
}

impl AiSettings {
    pub fn status(&self, has_key: bool) -> AiStatus {
        AiStatus { provider: self.provider, base_url: self.base_url.clone(), model: self.model.clone(), has_key }
    }

    /// "Anthropic", or the host of an OpenAI-compatible server ("openrouter.ai").
    fn name(&self) -> String {
        match self.provider {
            AiProvider::Anthropic => "Anthropic".to_owned(),
            AiProvider::Gemini => "Gemini".to_owned(),
            AiProvider::OpenAi => reqwest::Url::parse(&self.base_url)
                .ok()
                .and_then(|u| u.host_str().map(str::to_owned))
                .unwrap_or_else(|| "The AI provider".to_owned()),
        }
    }
}

/// What the UI sees: the settings, and whether a key is saved (never the key).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    pub provider: AiProvider,
    pub base_url: String,
    pub model: String,
    pub has_key: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiInput {
    pub provider: AiProvider,
    pub base_url: String,
    pub model: String,
    /// None keeps the saved key, Some("") removes it.
    pub api_key: Option<String>,
}

impl AiInput {
    pub fn settings(&self) -> AppResult<AiSettings> {
        let base_url = self.base_url.trim().trim_end_matches('/').to_owned();
        let mut model = self.model.trim();
        if self.provider == AiProvider::Gemini {
            // Google's model list shows ids as "models/gemini-…".
            model = model.trim_start_matches("models/");
        }
        let model = model.to_owned();
        if model.is_empty() {
            return Err(AppError::invalid("Enter a model."));
        }
        let valid = reqwest::Url::parse(&base_url).is_ok_and(|u| matches!(u.scheme(), "http" | "https"));
        if !valid {
            return Err(AppError::invalid("The base URL must be an http:// or https:// address."));
        }
        Ok(AiSettings { provider: self.provider, base_url, model })
    }
}

/// A statement that failed, and what Postgres said about it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FixInput {
    /// Just the failing statement, not the whole script.
    pub sql: String,
    pub message: String,
    pub detail: Option<String>,
    pub hint: Option<String>,
    pub code: Option<String>,
    /// 1-based line and column of the error within `sql`.
    pub line: Option<usize>,
    pub col: Option<usize>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FixResult {
    pub sql: String,
    pub explanation: String,
}

// ------------------------------------------------------------------ settings

#[derive(Serialize, Deserialize)]
struct AiFile {
    version: u32,
    settings: Option<AiSettings>,
}

pub struct AiStore {
    path: PathBuf,
    settings: Mutex<Option<AiSettings>>,
}

impl AiStore {
    /// Loads the saved settings. A missing or damaged file only means AI
    /// isn't set up; it never stops the app from starting.
    pub fn load(path: PathBuf) -> Self {
        let settings = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<AiFile>(&text).ok())
            .and_then(|file| file.settings);
        AiStore { path, settings: Mutex::new(settings) }
    }

    pub fn get(&self) -> Option<AiSettings> {
        self.settings.lock().unwrap().clone()
    }

    pub fn save(&self, settings: AiSettings) -> AppResult<()> {
        let mut current = self.settings.lock().unwrap();
        let file = AiFile { version: 1, settings: Some(settings.clone()) };
        write_json_atomic(&self.path, &file).map_err(|(path, reason)| {
            AppError::new(ErrorKind::Config, format!("Could not save AI settings to {}: {reason}", path.display()))
        })?;
        *current = Some(settings);
        Ok(())
    }
}

// ------------------------------------------------------------------ providers

pub fn http_client() -> reqwest::Client {
    // Reasoning models can think for a while before answering.
    reqwest::Client::builder().timeout(Duration::from_secs(90)).build().expect("HTTP client")
}

/// Sends one system + user message and returns the model's text reply.
pub async fn complete(http: &reqwest::Client, s: &AiSettings, key: Option<&str>, system: &str, user: &str) -> AppResult<String> {
    let key = key.filter(|k| !k.is_empty());
    let base = s.base_url.trim_end_matches('/');
    let request = match s.provider {
        AiProvider::OpenAi => {
            // No temperature: some reasoning models only accept the default.
            let request = http.post(format!("{base}/chat/completions")).json(&json!({
                "model": s.model,
                "messages": [
                    { "role": "system", "content": system },
                    { "role": "user", "content": user },
                ],
            }));
            // Local servers (Ollama, LM Studio) don't need a key.
            match key {
                Some(key) => request.bearer_auth(key),
                None => request,
            }
        }
        AiProvider::Anthropic => {
            let key = key.ok_or_else(|| AppError::new(ErrorKind::Ai, "Anthropic needs an API key.").with_hint(KEY_HINT))?;
            http.post(format!("{base}/v1/messages"))
                .header("x-api-key", key)
                .header("anthropic-version", "2023-06-01")
                .json(&json!({
                    "model": s.model,
                    "max_tokens": MAX_TOKENS,
                    "system": system,
                    "messages": [{ "role": "user", "content": user }],
                }))
        }
        AiProvider::Gemini => {
            let key = key.ok_or_else(|| AppError::new(ErrorKind::Ai, "Gemini needs an API key.").with_hint(KEY_HINT))?;
            // No maxOutputTokens: thinking tokens count against it, and a
            // tight cap can end the reply before any text.
            http.post(format!("{base}/models/{}:generateContent", s.model))
                .header("x-goog-api-key", key)
                .json(&json!({
                    "systemInstruction": { "parts": [{ "text": system }] },
                    "contents": [{ "role": "user", "parts": [{ "text": user }] }],
                }))
        }
    };

    let response = request.send().await?;
    let status = response.status();
    let body: Option<Value> = serde_json::from_str(&response.text().await?).ok();

    if !status.is_success() {
        let reason = body.as_ref().and_then(error_message).unwrap_or_else(|| status.to_string());
        let err = AppError::new(ErrorKind::Ai, format!("{} returned {}: {reason}", s.name(), status.as_u16()));
        // Gemini answers a bad key with 400 "API key not valid".
        let bad_key = matches!(status.as_u16(), 401 | 403) || reason.contains("API key");
        return Err(match status.as_u16() {
            _ if bad_key => err.with_hint(KEY_HINT),
            404 => err.with_hint("Check the base URL and model in Settings → AI."),
            _ => err,
        });
    }

    let body = body.ok_or_else(|| AppError::new(ErrorKind::Ai, format!("{} sent a reply that isn't JSON.", s.name())))?;
    let text = match s.provider {
        AiProvider::OpenAi => body.pointer("/choices/0/message/content").and_then(Value::as_str).map(str::to_owned),
        AiProvider::Anthropic => body.get("content").and_then(Value::as_array).map(|blocks| {
            blocks
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .collect::<String>()
        }),
        AiProvider::Gemini => body.pointer("/candidates/0/content/parts").and_then(Value::as_array).map(|parts| {
            parts
                .iter()
                .filter(|p| p.get("thought").and_then(Value::as_bool) != Some(true))
                .filter_map(|p| p.get("text").and_then(Value::as_str))
                .collect::<String>()
        }),
    };
    match text.filter(|t| !t.trim().is_empty()) {
        Some(text) => Ok(text),
        // OpenRouter can answer 200 with an error body when the upstream model fails.
        None => Err(AppError::new(
            ErrorKind::Ai,
            match (error_message(&body), stop_reason(&body)) {
                (Some(reason), _) => format!("{} returned an error: {reason}", s.name()),
                (None, Some(reason)) => format!("{} stopped without an answer ({reason}).", s.name()),
                (None, None) => format!("{} returned an empty answer.", s.name()),
            },
        )),
    }
}

/// Why Gemini gave no text: a blocked prompt or a finish reason such as SAFETY.
fn stop_reason(body: &Value) -> Option<String> {
    ["/promptFeedback/blockReason", "/candidates/0/finishReason"]
        .iter()
        .find_map(|p| body.pointer(p).and_then(Value::as_str))
        .map(str::to_owned)
}

/// `{"error": {"message": …}}` (OpenAI, OpenRouter, Anthropic) or `{"error": "…"}`.
fn error_message(body: &Value) -> Option<String> {
    let error = body.get("error")?;
    error.get("message").and_then(Value::as_str).or_else(|| error.as_str()).map(str::to_owned)
}

/// Collapses a reply onto one line and shortens it, for status messages.
pub fn one_line(text: &str, max_chars: usize) -> String {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= max_chars {
        return line;
    }
    line.chars().take(max_chars).collect::<String>() + "…"
}

// ------------------------------------------------------------------ fix SQL

pub fn fix_prompt(input: &FixInput, server_version: &str, schema: &str) -> (String, String) {
    let system = format!(
        "You fix SQL statements for PostgreSQL {server_version}. You get one statement that failed, \
         the error PostgreSQL returned, and the relevant part of the database schema.\n\n\
         Rules:\n\
         - Change only what is needed to fix the error. Keep the original formatting, casing, aliases, comments and intent.\n\
         - Return exactly one statement, without a trailing semicolon. Never add statements.\n\
         - Use only tables and columns that exist in the schema. If the intent is unclear, make the most likely fix.\n\n\
         Reply with the corrected statement in a single ```sql code block, then one short sentence that says what you changed."
    );

    let mut user = format!("Statement:\n```sql\n{}\n```\n\nError: ", input.sql.trim_end());
    if let Some(code) = &input.code {
        user.push_str(&format!("[{code}] "));
    }
    user.push_str(&input.message);
    if let (Some(line), Some(col)) = (input.line, input.col) {
        user.push_str(&format!(" (at line {line}, column {col} of the statement)"));
    }
    if let Some(detail) = &input.detail {
        user.push_str(&format!("\nDetail: {detail}"));
    }
    if let Some(hint) = &input.hint {
        user.push_str(&format!("\nHint: {hint}"));
    }
    if !schema.is_empty() {
        user.push_str(&format!("\n\nSchema:\n{schema}"));
    }
    (system, user)
}

/// Names and column types only, never row data: every table and view by
/// name (so a misspelled one can be corrected), plus the columns of the ones
/// the statement mentions.
pub async fn schema_context(client: &Client, sql: &str) -> AppResult<String> {
    let relations = catalog::list_relations(client).await?;
    let words = identifiers(sql);
    let mentioned = relations.iter().filter(|r| words.contains(&r.name.to_lowercase())).take(MAX_DESCRIBED);
    let details = futures_util::future::try_join_all(mentioned.map(|r| catalog::describe_table(client, &r.schema, &r.name))).await?;

    let mut out = String::new();
    for table in &details {
        out.push_str(&describe(table));
        out.push('\n');
    }
    let names: Vec<String> = relations.iter().take(MAX_LISTED).map(|r| format!("{}.{}", r.schema, r.name)).collect();
    if !names.is_empty() {
        out.push_str(&format!("All tables and views: {}", names.join(", ")));
        if relations.len() > MAX_LISTED {
            out.push_str(&format!(", … and {} more", relations.len() - MAX_LISTED));
        }
        out.push('\n');
    }
    Ok(out)
}

/// `public.orders(id int8 PK, customer_id int8 → public.customers(id), …)`
fn describe(table: &TableDetails) -> String {
    let columns: Vec<String> = table
        .columns
        .iter()
        .map(|c| {
            let mut col = format!("{} {}", c.name, c.data_type);
            if c.is_primary_key {
                col.push_str(" PK");
            }
            if let Some(target) = &c.references {
                col.push_str(&format!(" → {target}"));
            }
            col
        })
        .collect();
    format!("{}.{}({})", table.schema, table.name, columns.join(", "))
}

/// Lowercased words of `sql` that could name a relation, with identifier
/// quotes removed and string literals skipped:
/// `select * from public."Order Items" where s = 'x'` → {select, from, public, order items, where, s}.
fn identifiers(sql: &str) -> HashSet<String> {
    let mut out = HashSet::new();
    let mut chars = sql.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' | '\'' => {
                let mut text = String::new();
                while let Some(ch) = chars.next() {
                    if ch != c {
                        text.push(ch);
                    } else if chars.peek() == Some(&c) {
                        // A doubled quote is an escaped one.
                        text.push(ch);
                        chars.next();
                    } else {
                        break;
                    }
                }
                if c == '"' {
                    out.insert(text.to_lowercase());
                }
            }
            c if c.is_alphabetic() || c == '_' => {
                let mut word = String::from(c);
                while let Some(&ch) = chars.peek() {
                    if !(ch.is_alphanumeric() || ch == '_' || ch == '$') {
                        break;
                    }
                    word.push(ch);
                    chars.next();
                }
                out.insert(word.to_lowercase());
            }
            _ => {}
        }
    }
    out
}

/// Pulls the statement out of the model's reply: the first ```sql block (or
/// any ``` block), or the whole reply when there is none. The text around
/// the block is the explanation.
pub fn parse_reply(reply: &str, original: &str) -> AppResult<FixResult> {
    let (sql, explanation) = match fenced_block(reply) {
        Some((code, rest)) => (code, rest),
        None => (reply.trim().to_owned(), String::new()),
    };

    // The splitter hands over statements without their semicolon, and the
    // editor still has it, so don't let the model add a second one.
    let mut sql = sql.trim().to_owned();
    if !original.trim_end().ends_with(';') {
        sql = sql.trim_end_matches(|c: char| c == ';' || c.is_whitespace()).to_owned();
    }
    if sql.is_empty() {
        return Err(AppError::new(ErrorKind::Ai, "The model didn't return a statement."));
    }

    let explanation = one_line(&explanation, 400);
    if one_line(&sql, usize::MAX) == one_line(original, usize::MAX) {
        let err = AppError::new(ErrorKind::Ai, "The model couldn't find a fix: it returned the statement unchanged.");
        return Err(if explanation.is_empty() { err } else { err.with_hint(explanation) });
    }
    let explanation = if explanation.is_empty() { "Applied the suggested fix.".to_owned() } else { explanation };
    Ok(FixResult { sql, explanation })
}

/// The code inside the first fenced block, and the reply's other text.
fn fenced_block(reply: &str) -> Option<(String, String)> {
    let start = reply.find("```sql").or_else(|| reply.find("```"))?;
    let after = &reply[start + 3..];
    let end = after.find("```")?;
    let block = &after[..end];
    // Drop the language tag ("sql", "postgresql", …) on the opening line.
    let code = match block.split_once('\n') {
        Some((tag, code)) if !tag.trim().contains(char::is_whitespace) => code,
        _ => block,
    };
    let rest = format!("{} {}", &reply[..start], &after[end + 3..]);
    Some((code.to_owned(), rest.trim().to_owned()))
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::http::{HeaderMap, StatusCode};
    use axum::routing::post;
    use axum::{Json, Router};

    use super::*;

    type Seen = Arc<Mutex<Option<(HeaderMap, Value)>>>;

    /// A stand-in provider on a random local port: records the request it
    /// gets on `path` and answers with `status` and `reply`.
    async fn fake_provider(path: &'static str, status: u16, reply: Value) -> (String, Seen) {
        let seen: Seen = Arc::default();
        let record = seen.clone();
        let app = Router::new().route(
            path,
            post(move |headers: HeaderMap, Json(body): Json<Value>| {
                let record = record.clone();
                let reply = reply.clone();
                async move {
                    *record.lock().unwrap() = Some((headers, body));
                    (StatusCode::from_u16(status).unwrap(), Json(reply))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        (format!("http://{addr}"), seen)
    }

    fn client() -> reqwest::Client {
        reqwest::Client::builder().no_proxy().build().unwrap()
    }

    fn settings(provider: AiProvider, base_url: String) -> AiSettings {
        AiSettings { provider, base_url, model: "test-model".into() }
    }

    fn header<'a>(seen: &'a Option<(HeaderMap, Value)>, name: &str) -> Option<&'a str> {
        seen.as_ref().unwrap().0.get(name).map(|v| v.to_str().unwrap())
    }

    #[tokio::test]
    async fn talks_openai_chat_completions() {
        let reply = json!({ "choices": [{ "message": { "role": "assistant", "content": "SELECT 1" } }] });
        let (url, seen) = fake_provider("/v1/chat/completions", 200, reply).await;
        let s = settings(AiProvider::OpenAi, format!("{url}/v1/"));

        let text = complete(&client(), &s, Some("sk-test"), "be brief", "fix it").await.unwrap();
        assert_eq!(text, "SELECT 1");

        let seen = seen.lock().unwrap();
        assert_eq!(header(&seen, "authorization"), Some("Bearer sk-test"));
        let body = &seen.as_ref().unwrap().1;
        assert_eq!(body["model"], "test-model");
        assert_eq!(body["messages"][0], json!({ "role": "system", "content": "be brief" }));
        assert_eq!(body["messages"][1], json!({ "role": "user", "content": "fix it" }));
    }

    #[tokio::test]
    async fn sends_no_auth_header_without_a_key() {
        let reply = json!({ "choices": [{ "message": { "content": "OK" } }] });
        let (url, seen) = fake_provider("/v1/chat/completions", 200, reply).await;
        let s = settings(AiProvider::OpenAi, format!("{url}/v1"));

        complete(&client(), &s, None, "s", "u").await.unwrap();
        assert_eq!(header(&seen.lock().unwrap(), "authorization"), None);
    }

    #[tokio::test]
    async fn talks_anthropic_messages() {
        let reply = json!({ "content": [{ "type": "text", "text": "Hello " }, { "type": "tool_use" }, { "type": "text", "text": "world" }] });
        let (url, seen) = fake_provider("/v1/messages", 200, reply).await;
        let s = settings(AiProvider::Anthropic, url);

        let text = complete(&client(), &s, Some("sk-ant"), "be brief", "fix it").await.unwrap();
        assert_eq!(text, "Hello world");

        let seen = seen.lock().unwrap();
        assert_eq!(header(&seen, "x-api-key"), Some("sk-ant"));
        assert_eq!(header(&seen, "anthropic-version"), Some("2023-06-01"));
        let body = &seen.as_ref().unwrap().1;
        assert_eq!(body["system"], "be brief");
        assert_eq!(body["max_tokens"], MAX_TOKENS);
        assert_eq!(body["messages"], json!([{ "role": "user", "content": "fix it" }]));
    }

    #[tokio::test]
    async fn maps_a_rejected_key_to_an_ai_error_with_a_hint() {
        let reply = json!({ "type": "error", "error": { "type": "authentication_error", "message": "invalid x-api-key" } });
        let (url, _) = fake_provider("/v1/messages", 401, reply).await;
        let s = settings(AiProvider::Anthropic, url);

        let err = complete(&client(), &s, Some("wrong"), "s", "u").await.unwrap_err();
        assert_eq!(err.kind, ErrorKind::Ai);
        assert_eq!(err.message, "Anthropic returned 401: invalid x-api-key");
        assert_eq!(err.hint.as_deref(), Some(KEY_HINT));
    }

    #[tokio::test]
    async fn talks_gemini_generate_content() {
        let reply = json!({ "candidates": [{ "content": { "role": "model", "parts": [
            { "text": "thinking it over", "thought": true },
            { "text": "SELECT " },
            { "text": "1" },
        ] }, "finishReason": "STOP" }] });
        let (url, seen) = fake_provider("/v1beta/models/test-model:generateContent", 200, reply).await;
        let s = settings(AiProvider::Gemini, format!("{url}/v1beta"));

        let text = complete(&client(), &s, Some("AIza-test"), "be brief", "fix it").await.unwrap();
        assert_eq!(text, "SELECT 1");

        let seen = seen.lock().unwrap();
        assert_eq!(header(&seen, "x-goog-api-key"), Some("AIza-test"));
        let body = &seen.as_ref().unwrap().1;
        assert_eq!(body["systemInstruction"], json!({ "parts": [{ "text": "be brief" }] }));
        assert_eq!(body["contents"], json!([{ "role": "user", "parts": [{ "text": "fix it" }] }]));
    }

    #[tokio::test]
    async fn explains_a_gemini_reply_without_text() {
        let reply = json!({ "promptFeedback": { "blockReason": "SAFETY" } });
        let (url, _) = fake_provider("/v1beta/models/test-model:generateContent", 200, reply).await;
        let s = settings(AiProvider::Gemini, format!("{url}/v1beta"));

        let err = complete(&client(), &s, Some("k"), "s", "u").await.unwrap_err();
        assert_eq!(err.message, "Gemini stopped without an answer (SAFETY).");
    }

    #[tokio::test]
    async fn hints_at_the_key_when_gemini_rejects_it() {
        let reply = json!({ "error": { "code": 400, "message": "API key not valid. Please pass a valid API key.", "status": "INVALID_ARGUMENT" } });
        let (url, _) = fake_provider("/v1beta/models/test-model:generateContent", 400, reply).await;
        let s = settings(AiProvider::Gemini, format!("{url}/v1beta"));

        let err = complete(&client(), &s, Some("wrong"), "s", "u").await.unwrap_err();
        assert_eq!(err.message, "Gemini returned 400: API key not valid. Please pass a valid API key.");
        assert_eq!(err.hint.as_deref(), Some(KEY_HINT));
    }

    #[tokio::test]
    async fn anthropic_needs_a_key() {
        let s = settings(AiProvider::Anthropic, "http://127.0.0.1:9".into());
        let err = complete(&client(), &s, None, "s", "u").await.unwrap_err();
        assert_eq!(err.kind, ErrorKind::Ai);
    }

    #[test]
    fn validates_settings() {
        let input = |base_url: &str, model: &str| AiInput {
            provider: AiProvider::OpenAi,
            base_url: base_url.into(),
            model: model.into(),
            api_key: None,
        };
        assert_eq!(input(" https://openrouter.ai/api/v1/ ", " m ").settings().unwrap().base_url, "https://openrouter.ai/api/v1");
        assert!(input("https://api.openai.com/v1", "").settings().is_err());
        assert!(input("api.openai.com/v1", "m").settings().is_err());
        assert!(input("ftp://example.com", "m").settings().is_err());

        let gemini = AiInput {
            provider: AiProvider::Gemini,
            base_url: "https://generativelanguage.googleapis.com/v1beta".into(),
            model: "models/gemini-3.8-flash".into(),
            api_key: None,
        };
        assert_eq!(gemini.settings().unwrap().model, "gemini-3.8-flash");
    }

    #[test]
    fn parses_fenced_replies() {
        let fix = parse_reply("```sql\nSELECT customer_id\nFROM orders\n```\nThe column is customer_id.", "SELECT custmer_id\nFROM orders").unwrap();
        assert_eq!(fix.sql, "SELECT customer_id\nFROM orders");
        assert_eq!(fix.explanation, "The column is customer_id.");

        let fix = parse_reply("Here you go:\n```\nselect 1\n```", "selec 1").unwrap();
        assert_eq!(fix.sql, "select 1");
        assert_eq!(fix.explanation, "Here you go:");

        // Prefers the sql block over an earlier one.
        let fix = parse_reply("```text\nnote\n```\n```sql\nselect 2\n```", "selec 2").unwrap();
        assert_eq!(fix.sql, "select 2");
    }

    #[test]
    fn parses_bare_replies_and_semicolons() {
        let fix = parse_reply("  SELECT 1;  ", "SELEC 1").unwrap();
        assert_eq!(fix.sql, "SELECT 1");
        assert_eq!(fix.explanation, "Applied the suggested fix.");

        // Keeps the semicolon when the original had one.
        assert_eq!(parse_reply("```sql\nSELECT 1;\n```", "SELEC 1;").unwrap().sql, "SELECT 1;");
    }

    #[test]
    fn rejects_empty_and_unchanged_replies() {
        assert_eq!(parse_reply("```sql\n\n```", "selec 1").unwrap_err().kind, ErrorKind::Ai);
        let err = parse_reply("```sql\nselect  1\n```\nIt looks fine.", "select 1").unwrap_err();
        assert_eq!(err.hint.as_deref(), Some("It looks fine."));
    }

    #[test]
    fn finds_identifiers() {
        let words = identifiers(r#"SELECT o.Id FROM public."Order Items" o WHERE note = 'from orders' AND "we""ird" = 1"#);
        for w in ["select", "o", "id", "public", "order items", "where", "note", "we\"ird"] {
            assert!(words.contains(w), "missing {w}");
        }
        assert!(!words.contains("orders"), "string literals are skipped");
    }

    #[test]
    fn builds_the_fix_prompt() {
        let input = FixInput {
            sql: "SELECT custmer_id FROM orders".into(),
            message: "column \"custmer_id\" does not exist".into(),
            detail: None,
            hint: Some("Perhaps you meant to reference the column \"orders.customer_id\".".into()),
            code: Some("42703".into()),
            line: Some(1),
            col: Some(8),
        };
        let (system, user) = fix_prompt(&input, "16.4", "public.orders(id int8 PK, customer_id int8)\n");
        assert!(system.contains("PostgreSQL 16.4"));
        assert!(user.contains("```sql\nSELECT custmer_id FROM orders\n```"));
        assert!(user.contains("Error: [42703] column \"custmer_id\" does not exist (at line 1, column 8 of the statement)"));
        assert!(user.contains("\nHint: Perhaps"));
        assert!(user.contains("Schema:\npublic.orders(id int8 PK, customer_id int8)"));
    }
}
