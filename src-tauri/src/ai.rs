//! AI providers, "Fix with AI" and the SQL chat. Three wire formats cover everything:
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
/// Room for a chat reply that rewrites a long script.
const MAX_TOKENS: u32 = 4096;
/// Tables whose columns are sent along with a fix or a chat request.
const MAX_DESCRIBED: usize = 10;
/// Table and view names listed so the model can correct a misspelled one.
const MAX_LISTED: usize = 300;
/// Chat turns sent with each request; older ones are dropped.
const MAX_TURNS: usize = 20;

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatRole {
    User,
    Assistant,
}

/// One turn of the chat, as the UI keeps it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTurn {
    pub role: ChatRole,
    pub text: String,
    /// The editor contents an assistant turn proposed.
    pub sql: Option<String>,
}

/// A request from the chat panel.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatInput {
    /// Everything in the editor right now.
    pub sql: String,
    /// The conversation so far, oldest first, ending with the user's request.
    pub turns: Vec<ChatTurn>,
    /// The editor is rendered as a Jinja template before it runs.
    #[serde(default)]
    pub jinja: bool,
}

impl ChatInput {
    /// The editor and what the user asked: their identifiers pick the tables
    /// whose columns go with the request.
    pub fn schema_hint(&self) -> String {
        let asked = self.turns.iter().filter(|t| t.role == ChatRole::User).map(|t| t.text.as_str());
        std::iter::once(self.sql.as_str()).chain(asked).collect::<Vec<_>>().join("\n")
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatResult {
    /// What the model said, without the SQL.
    pub reply: String,
    /// The new editor contents, or None when nothing should change.
    pub sql: Option<String>,
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
    converse(http, s, key, system, &[(ChatRole::User, user.to_owned())]).await
}

/// Sends a system prompt and a conversation (oldest first, starting and
/// ending with the user) and returns the model's text reply.
pub async fn converse(
    http: &reqwest::Client,
    s: &AiSettings,
    key: Option<&str>,
    system: &str,
    messages: &[(ChatRole, String)],
) -> AppResult<String> {
    let key = key.filter(|k| !k.is_empty());
    let base = s.base_url.trim_end_matches('/');
    // OpenAI and Anthropic name the roles alike; Gemini calls the assistant "model".
    let role = |r: ChatRole| match r {
        ChatRole::User => "user",
        ChatRole::Assistant => "assistant",
    };
    let request = match s.provider {
        AiProvider::OpenAi => {
            let mut all = vec![json!({ "role": "system", "content": system })];
            all.extend(messages.iter().map(|(r, content)| json!({ "role": role(*r), "content": content })));
            // No temperature: some reasoning models only accept the default.
            let request = http.post(format!("{base}/chat/completions")).json(&json!({
                "model": s.model,
                "messages": all,
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
                    "messages": messages.iter().map(|(r, content)| json!({ "role": role(*r), "content": content })).collect::<Vec<_>>(),
                }))
        }
        AiProvider::Gemini => {
            let key = key.ok_or_else(|| AppError::new(ErrorKind::Ai, "Gemini needs an API key.").with_hint(KEY_HINT))?;
            // No maxOutputTokens: thinking tokens count against it, and a
            // tight cap can end the reply before any text.
            let contents: Vec<Value> = messages
                .iter()
                .map(|(r, text)| {
                    let role = if *r == ChatRole::Assistant { "model" } else { "user" };
                    json!({ "role": role, "parts": [{ "text": text }] })
                })
                .collect();
            http.post(format!("{base}/models/{}:generateContent", s.model))
                .header("x-goog-api-key", key)
                .json(&json!({
                    "systemInstruction": { "parts": [{ "text": system }] },
                    "contents": contents,
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
        Some((_, code, rest)) => (code, rest),
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

/// The language tag and code of the first fenced block (preferring a ```sql
/// one), and the reply's other text.
fn fenced_block(reply: &str) -> Option<(String, String, String)> {
    let start = reply.find("```sql").or_else(|| reply.find("```"))?;
    let after = &reply[start + 3..];
    let end = after.find("```")?;
    let block = &after[..end];
    // Split off the language tag ("sql", "postgresql", …) on the opening line.
    let (tag, code) = match block.split_once('\n') {
        Some((tag, code)) if !tag.trim().contains(char::is_whitespace) => (tag.trim(), code),
        _ => ("", block),
    };
    let rest = format!("{} {}", &reply[..start], &after[end + 3..]);
    Some((tag.to_lowercase(), code.to_owned(), rest.trim().to_owned()))
}

// ------------------------------------------------------------------ chat

pub fn chat_prompt(input: &ChatInput, server_version: &str, schema: &str) -> AppResult<(String, Vec<(ChatRole, String)>)> {
    let postgres = if server_version.is_empty() { "PostgreSQL".to_owned() } else { format!("PostgreSQL {server_version}") };
    let mut system = format!(
        "You edit the SQL in the query editor of a {postgres} client. The user asks for changes in plain language, \
         and you rewrite what is in the editor to make them. Nothing runs until the user runs it.\n\n\
         Rules:\n\
         - To change the SQL, reply with the complete new editor contents in a single ```sql code block, then one or two short \
         sentences that say what you changed. Keep everything the request doesn't touch: other statements, formatting, casing, \
         aliases and comments.\n\
         - If the user only asks a question, answer in a few sentences of plain text, without a code block.\n\
         - Use only tables and columns that exist in the schema. If the request is ambiguous, make the most likely choice and say what you assumed.\n\
         - Don't use Markdown apart from that one code block."
    );
    if input.jinja {
        system.push_str(
            "\n- The editor is a Jinja template, rendered before it runs. Keep every {{ }}, {% %} and {# #} tag unless the user asks to change it.",
        );
    }
    if !schema.is_empty() {
        system.push_str(&format!("\n\nSchema:\n{schema}"));
    }

    let mut messages = chat_messages(&input.turns);
    let Some((ChatRole::User, request)) = messages.last_mut() else {
        return Err(AppError::invalid("Type a request first."));
    };
    // The editor as it is now, which may differ from what earlier turns proposed.
    let sql = input.sql.trim_end();
    let editor = if sql.trim().is_empty() { "The editor is empty.".to_owned() } else { format!("The editor contains:\n```sql\n{sql}\n```") };
    *request = format!("{editor}\n\nRequest: {request}");
    Ok((system, messages))
}

/// The last MAX_TURNS turns as provider messages, starting with the user and
/// alternating, as Anthropic and Gemini require. A failed request leaves two
/// user turns in a row; those are merged.
fn chat_messages(turns: &[ChatTurn]) -> Vec<(ChatRole, String)> {
    let mut out: Vec<(ChatRole, String)> = Vec::new();
    for turn in &turns[turns.len().saturating_sub(MAX_TURNS)..] {
        let mut text = turn.text.trim().to_owned();
        if let (ChatRole::Assistant, Some(sql)) = (turn.role, &turn.sql) {
            text = format!("```sql\n{}\n```\n{text}", sql.trim_end());
        }
        if text.is_empty() {
            continue;
        }
        match out.last_mut() {
            Some((role, previous)) if *role == turn.role => {
                previous.push_str("\n\n");
                previous.push_str(&text);
            }
            None if turn.role == ChatRole::Assistant => {}
            _ => out.push((turn.role, text)),
        }
    }
    out
}

/// Splits a chat reply into the new editor contents (its SQL code block) and
/// the rest of the text. No block, or one that matches the editor, means no change.
pub fn parse_chat_reply(reply: &str, current: &str) -> AppResult<ChatResult> {
    let block = fenced_block(reply).filter(|(tag, _, _)| matches!(tag.as_str(), "" | "sql" | "postgresql" | "postgres" | "pgsql" | "jinja"));
    let Some((_, code, rest)) = block else {
        // An opening fence without a closing one: the reply hit the token limit.
        if reply.matches("```").count() % 2 == 1 {
            return Err(AppError::new(ErrorKind::Ai, "The model's reply was cut off before the SQL ended.")
                .with_hint("Try again, or ask for a smaller change."));
        }
        return Ok(ChatResult { reply: reply.trim().to_owned(), sql: None });
    };

    // The text around the block, without the blank lines where it was.
    let rest = rest.lines().map(str::trim).filter(|l| !l.is_empty()).collect::<Vec<_>>().join("\n");
    let mut sql = code.trim_start_matches(['\r', '\n']).trim_end().to_owned();
    if sql.trim().is_empty() || sql.trim() == current.trim() {
        let reply = if rest.is_empty() { "No change needed.".to_owned() } else { rest };
        return Ok(ChatResult { reply, sql: None });
    }
    // Keep the editor's trailing newline, if it had one.
    if current.ends_with('\n') {
        sql.push('\n');
    }
    let reply = if rest.is_empty() { "Updated the SQL.".to_owned() } else { rest };
    Ok(ChatResult { reply, sql: Some(sql) })
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
    async fn sends_a_conversation_in_each_wire_format() {
        let turns = [(ChatRole::User, "a".to_owned()), (ChatRole::Assistant, "b".to_owned()), (ChatRole::User, "c".to_owned())];

        let reply = json!({ "choices": [{ "message": { "content": "OK" } }] });
        let (url, seen) = fake_provider("/v1/chat/completions", 200, reply).await;
        converse(&client(), &settings(AiProvider::OpenAi, format!("{url}/v1")), None, "s", &turns).await.unwrap();
        let roles: Vec<Value> = seen.lock().unwrap().as_ref().unwrap().1["messages"].as_array().unwrap().iter().map(|m| m["role"].clone()).collect();
        assert_eq!(roles, ["system", "user", "assistant", "user"]);

        let reply = json!({ "content": [{ "type": "text", "text": "OK" }] });
        let (url, seen) = fake_provider("/v1/messages", 200, reply).await;
        converse(&client(), &settings(AiProvider::Anthropic, url), Some("k"), "s", &turns).await.unwrap();
        assert_eq!(
            seen.lock().unwrap().as_ref().unwrap().1["messages"],
            json!([{ "role": "user", "content": "a" }, { "role": "assistant", "content": "b" }, { "role": "user", "content": "c" }])
        );

        let reply = json!({ "candidates": [{ "content": { "parts": [{ "text": "OK" }] } }] });
        let (url, seen) = fake_provider("/v1beta/models/test-model:generateContent", 200, reply).await;
        converse(&client(), &settings(AiProvider::Gemini, format!("{url}/v1beta")), Some("k"), "s", &turns).await.unwrap();
        assert_eq!(
            seen.lock().unwrap().as_ref().unwrap().1["contents"],
            json!([
                { "role": "user", "parts": [{ "text": "a" }] },
                { "role": "model", "parts": [{ "text": "b" }] },
                { "role": "user", "parts": [{ "text": "c" }] },
            ])
        );
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

    fn turn(role: ChatRole, text: &str, sql: Option<&str>) -> ChatTurn {
        ChatTurn { role, text: text.into(), sql: sql.map(Into::into) }
    }

    fn chat(sql: &str, turns: Vec<ChatTurn>) -> ChatInput {
        ChatInput { sql: sql.into(), turns, jinja: false }
    }

    #[test]
    fn builds_the_chat_prompt() {
        let input = chat(
            "SELECT * FROM orders WHERE total > 10\n",
            vec![
                turn(ChatRole::User, "only big orders", None),
                turn(ChatRole::Assistant, "Added a filter.", Some("SELECT * FROM orders WHERE total > 10")),
                turn(ChatRole::User, "  and sort by date ", None),
            ],
        );
        let (system, messages) = chat_prompt(&input, "16.4", "public.orders(id int8 PK, total numeric)\n").unwrap();
        assert!(system.contains("PostgreSQL 16.4"));
        assert!(system.contains("Schema:\npublic.orders(id int8 PK, total numeric)"));
        assert!(!system.contains("Jinja"));

        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0], (ChatRole::User, "only big orders".to_owned()));
        assert_eq!(messages[1], (ChatRole::Assistant, "```sql\nSELECT * FROM orders WHERE total > 10\n```\nAdded a filter.".to_owned()));
        // The editor goes with the latest request, since it may have changed since.
        assert_eq!(
            messages[2],
            (ChatRole::User, "The editor contains:\n```sql\nSELECT * FROM orders WHERE total > 10\n```\n\nRequest: and sort by date".to_owned())
        );

        let jinja = ChatInput { jinja: true, ..chat("", vec![turn(ChatRole::User, "count orders", None)]) };
        let (system, messages) = chat_prompt(&jinja, "", "").unwrap();
        assert!(system.contains("of a PostgreSQL client."));
        assert!(system.contains("Jinja template"));
        assert!(!system.contains("Schema:"));
        assert_eq!(messages[0].1, "The editor is empty.\n\nRequest: count orders");
    }

    #[test]
    fn keeps_chat_turns_alternating() {
        // Two user turns in a row (the first request failed) are merged.
        let merged = chat_messages(&[turn(ChatRole::User, "first", None), turn(ChatRole::User, "second", None)]);
        assert_eq!(merged, [(ChatRole::User, "first\n\nsecond".to_owned())]);

        // Cutting the history to MAX_TURNS never starts on an assistant turn.
        let mut turns = Vec::new();
        for i in 0..MAX_TURNS + 1 {
            let role = if i % 2 == 0 { ChatRole::User } else { ChatRole::Assistant };
            turns.push(turn(role, &format!("t{i}"), None));
        }
        let messages = chat_messages(&turns);
        assert_eq!(messages[0], (ChatRole::User, "t2".to_owned()));
        assert_eq!(messages.len(), MAX_TURNS - 1);

        let err = chat_prompt(&chat("select 1", vec![turn(ChatRole::Assistant, "hi", None)]), "", "").unwrap_err();
        assert_eq!(err.kind, ErrorKind::Invalid);
    }

    #[test]
    fn parses_chat_replies() {
        let current = "SELECT * FROM orders\n";
        let r = parse_chat_reply("Here you go:\n```sql\nSELECT * FROM orders\nORDER BY created_at DESC\n```\nSorted newest first.", current).unwrap();
        assert_eq!(r.sql.as_deref(), Some("SELECT * FROM orders\nORDER BY created_at DESC\n"), "keeps the editor's trailing newline");
        assert_eq!(r.reply, "Here you go:\nSorted newest first.");

        // A question gets a plain answer and leaves the editor alone.
        let r = parse_chat_reply("It lists every order.", current).unwrap();
        assert_eq!(r, ChatResult { reply: "It lists every order.".into(), sql: None });

        // Same SQL back means no change; only reformatting is still a change.
        let r = parse_chat_reply("```sql\nSELECT * FROM orders\n```\nIt already does that.", current).unwrap();
        assert_eq!(r, ChatResult { reply: "It already does that.".into(), sql: None });
        let r = parse_chat_reply("```sql\nSELECT *\nFROM orders\n```", current).unwrap();
        assert_eq!(r.sql.as_deref(), Some("SELECT *\nFROM orders\n"));
        assert_eq!(r.reply, "Updated the SQL.");

        // A block in another language is part of the answer, not new SQL.
        let r = parse_chat_reply("Run:\n```bash\npsql -f x.sql\n```", current).unwrap();
        assert_eq!(r.sql, None);

        let err = parse_chat_reply("```sql\nSELECT * FROM orders WHERE", current).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Ai);
    }

    #[test]
    fn hints_tables_from_the_editor_and_the_requests() {
        let input = chat(
            "select * from orders",
            vec![turn(ChatRole::User, "join customers", None), turn(ChatRole::Assistant, "see invoices", None)],
        );
        let words = identifiers(&input.schema_hint());
        assert!(words.contains("orders") && words.contains("customers"));
        assert!(!words.contains("invoices"), "only the user's turns count");
    }
}
