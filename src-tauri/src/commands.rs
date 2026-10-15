//! The commands the UI calls — the only surface the webview has to the
//! database. The logic lives on `AppState` so the Tauri command wrappers at
//! the bottom (and the browser dev bridge in examples/) share one
//! implementation.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Deserialize;
use tauri::State;

use crate::ai::{self, AiInput, AiProvider, AiStatus, AiStore, FixInput, FixResult};
use crate::db::catalog::{self, RelationRef, SchemaInfo, SchemaObjects, TableDetails};
use crate::db::query::{self, RunResult};
use crate::db::{ConnectParams, ServerInfo, Session, Sessions, SslMode};
use crate::error::{AppError, AppResult};
use crate::profiles::{ConnectionProfile, ProfileStore};
use crate::secrets;

pub struct AppState {
    pub profiles: ProfileStore,
    pub ai: AiStore,
    pub sessions: Sessions,
    /// Every app launch starts read-only; the UI toggle switches it off.
    pub read_only: AtomicBool,
    /// Shared by every AI provider call.
    http: reqwest::Client,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInput {
    /// None when creating a new connection.
    pub id: Option<String>,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    pub ssl_mode: SslMode,
    /// None keeps the saved password, Some("") removes it.
    pub password: Option<String>,
}

impl ConnectionInput {
    fn validate(&self) -> AppResult<()> {
        let missing: Vec<&str> = [("name", &self.name), ("host", &self.host), ("database", &self.database), ("user", &self.user)]
            .iter()
            .filter(|(_, v)| v.trim().is_empty())
            .map(|(k, _)| *k)
            .collect();
        if !missing.is_empty() {
            return Err(AppError::invalid(format!("Fill in: {}.", missing.join(", "))));
        }
        if self.port == 0 {
            return Err(AppError::invalid("Port must be between 1 and 65535."));
        }
        Ok(())
    }

    fn profile(&self, id: String) -> ConnectionProfile {
        ConnectionProfile {
            id,
            name: self.name.trim().to_owned(),
            host: self.host.trim().to_owned(),
            port: self.port,
            database: self.database.trim().to_owned(),
            user: self.user.trim().to_owned(),
            ssl_mode: self.ssl_mode,
        }
    }
}

/// Keychain calls can block (macOS may show an access prompt), so keep them
/// off the async runtime's worker threads.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> AppResult<T> + Send + 'static) -> AppResult<T> {
    tokio::task::spawn_blocking(f).await.map_err(|e| AppError::invalid(format!("Background task failed: {e}")))?
}

fn params(profile: &ConnectionProfile, password: Option<String>) -> ConnectParams {
    ConnectParams {
        host: profile.host.clone(),
        port: profile.port,
        database: profile.database.clone(),
        user: profile.user.clone(),
        password,
        ssl_mode: profile.ssl_mode,
    }
}

impl AppState {
    pub fn new(profiles: ProfileStore, ai: AiStore) -> Self {
        AppState { profiles, ai, sessions: Sessions::default(), read_only: AtomicBool::new(true), http: ai::http_client() }
    }

    fn is_read_only(&self) -> bool {
        self.read_only.load(Ordering::SeqCst)
    }

    // -------------------------------------------------------------- connections

    pub async fn list_connections(&self) -> AppResult<Vec<ConnectionProfile>> {
        Ok(self.profiles.list())
    }

    pub async fn save_connection(&self, input: ConnectionInput) -> AppResult<ConnectionProfile> {
        input.validate()?;
        let profile = input.profile(input.id.clone().unwrap_or_else(|| uuid::Uuid::new_v4().to_string()));
        if let Some(password) = input.password {
            let id = profile.id.clone();
            blocking(move || if password.is_empty() { secrets::delete_password(&id) } else { secrets::set_password(&id, &password) }).await?;
        }
        self.profiles.upsert(profile.clone())?;
        // Settings changed: drop the live session so the next connect uses them.
        self.sessions.remove(&profile.id).await;
        Ok(profile)
    }

    pub async fn delete_connection(&self, id: String) -> AppResult<()> {
        self.sessions.remove(&id).await;
        let key = id.clone();
        blocking(move || secrets::delete_password(&key)).await?;
        self.profiles.remove(&id)
    }

    /// Connects with the form's values without saving anything.
    pub async fn test_connection(&self, input: ConnectionInput) -> AppResult<ServerInfo> {
        input.validate()?;
        let password = match (input.password.clone(), input.id.clone()) {
            (Some(p), _) => Some(p),
            (None, Some(id)) => blocking(move || secrets::get_password(&id)).await?,
            (None, None) => None,
        };
        let session = Session::connect(params(&input.profile(String::new()), password), self.is_read_only()).await?;
        Ok(session.info.clone())
    }

    pub async fn connect(&self, id: String) -> AppResult<ServerInfo> {
        let profile = self.profiles.get(&id)?;
        let key = id.clone();
        let password = blocking(move || secrets::get_password(&key)).await?;
        let session = Session::connect(params(&profile, password), self.is_read_only()).await?;
        let info = session.info.clone();
        self.sessions.insert(&id, session).await;
        Ok(info)
    }

    pub async fn disconnect(&self, id: String) -> AppResult<()> {
        self.sessions.remove(&id).await;
        Ok(())
    }

    // -------------------------------------------------------------- explorer

    pub async fn list_schemas(&self, id: String) -> AppResult<Vec<SchemaInfo>> {
        let session = self.sessions.get(&id).await?;
        catalog::list_schemas(&*session.meta().await?).await
    }

    pub async fn list_schema_objects(&self, id: String, schema: String) -> AppResult<SchemaObjects> {
        let session = self.sessions.get(&id).await?;
        catalog::list_schema_objects(&*session.meta().await?, &schema).await
    }

    pub async fn describe_table(&self, id: String, schema: String, name: String) -> AppResult<TableDetails> {
        let session = self.sessions.get(&id).await?;
        catalog::describe_table(&*session.meta().await?, &schema, &name).await
    }

    pub async fn list_relations(&self, id: String) -> AppResult<Vec<RelationRef>> {
        let session = self.sessions.get(&id).await?;
        catalog::list_relations(&*session.meta().await?).await
    }

    pub async fn function_definition(&self, id: String, oid: u32) -> AppResult<String> {
        let session = self.sessions.get(&id).await?;
        catalog::function_definition(&*session.meta().await?, oid).await
    }

    // -------------------------------------------------------------- editor

    pub async fn run_query(&self, id: String, sql: String) -> AppResult<RunResult> {
        let session = self.sessions.get(&id).await?;
        query::run(&session, &sql, self.is_read_only()).await
    }

    pub async fn cancel_query(&self, id: String) -> AppResult<()> {
        self.sessions.get(&id).await?.cancel().await
    }

    pub async fn get_read_only(&self) -> AppResult<bool> {
        Ok(self.is_read_only())
    }

    pub async fn set_read_only(&self, value: bool) -> AppResult<bool> {
        self.read_only.store(value, Ordering::SeqCst);
        for session in self.sessions.all().await {
            session.apply_read_only(value).await?;
        }
        Ok(value)
    }

    // -------------------------------------------------------------- AI

    async fn ai_key(&self, provider: AiProvider) -> AppResult<Option<String>> {
        blocking(move || secrets::get_password(provider.key_account())).await
    }

    pub async fn get_ai_settings(&self) -> AppResult<Option<AiStatus>> {
        let Some(settings) = self.ai.get() else { return Ok(None) };
        let has_key = self.ai_key(settings.provider).await?.is_some();
        Ok(Some(settings.status(has_key)))
    }

    pub async fn save_ai_settings(&self, input: AiInput) -> AppResult<AiStatus> {
        let settings = input.settings()?;
        if let Some(key) = input.api_key {
            let account = settings.provider.key_account();
            let key = key.trim().to_owned();
            blocking(move || if key.is_empty() { secrets::delete_password(account) } else { secrets::set_password(account, &key) }).await?;
        }
        self.ai.save(settings.clone())?;
        let has_key = self.ai_key(settings.provider).await?.is_some();
        Ok(settings.status(has_key))
    }

    /// Asks the model for a one-word reply with the form's values, without saving anything.
    pub async fn test_ai(&self, input: AiInput) -> AppResult<String> {
        let settings = input.settings()?;
        let key = match input.api_key {
            Some(key) => Some(key.trim().to_owned()),
            None => self.ai_key(settings.provider).await?,
        };
        let reply = ai::complete(&self.http, &settings, key.as_deref(), "You are a connection check.", "Reply with just the word OK.").await?;
        Ok(format!("{} replied “{}”", settings.model, ai::one_line(&reply, 60)))
    }

    pub async fn fix_sql(&self, id: String, input: FixInput) -> AppResult<FixResult> {
        let settings = self
            .ai
            .get()
            .ok_or_else(|| AppError::invalid("Set up an AI provider first.").with_hint("Open Settings → AI."))?;
        let key = self.ai_key(settings.provider).await?;
        let session = self.sessions.get(&id).await?;
        // Best effort: a fix without schema context is still worth asking for.
        let schema = match session.meta().await {
            Ok(client) => ai::schema_context(&client, &input.sql).await.unwrap_or_default(),
            Err(_) => String::new(),
        };
        let (system, user) = ai::fix_prompt(&input, &session.info.version, &schema);
        let reply = ai::complete(&self.http, &settings, key.as_deref(), &system, &user).await?;
        ai::parse_reply(&reply, &input.sql)
    }
}

// ------------------------------------------------------------------ Tauri commands

#[tauri::command]
pub async fn list_connections(state: State<'_, AppState>) -> AppResult<Vec<ConnectionProfile>> {
    state.list_connections().await
}

#[tauri::command]
pub async fn save_connection(state: State<'_, AppState>, input: ConnectionInput) -> AppResult<ConnectionProfile> {
    state.save_connection(input).await
}

#[tauri::command]
pub async fn delete_connection(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.delete_connection(id).await
}

#[tauri::command]
pub async fn test_connection(state: State<'_, AppState>, input: ConnectionInput) -> AppResult<ServerInfo> {
    state.test_connection(input).await
}

#[tauri::command]
pub async fn connect(state: State<'_, AppState>, id: String) -> AppResult<ServerInfo> {
    state.connect(id).await
}

#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.disconnect(id).await
}

#[tauri::command]
pub async fn list_schemas(state: State<'_, AppState>, id: String) -> AppResult<Vec<SchemaInfo>> {
    state.list_schemas(id).await
}

#[tauri::command]
pub async fn list_schema_objects(state: State<'_, AppState>, id: String, schema: String) -> AppResult<SchemaObjects> {
    state.list_schema_objects(id, schema).await
}

#[tauri::command]
pub async fn describe_table(state: State<'_, AppState>, id: String, schema: String, name: String) -> AppResult<TableDetails> {
    state.describe_table(id, schema, name).await
}

#[tauri::command]
pub async fn list_relations(state: State<'_, AppState>, id: String) -> AppResult<Vec<RelationRef>> {
    state.list_relations(id).await
}

#[tauri::command]
pub async fn function_definition(state: State<'_, AppState>, id: String, oid: u32) -> AppResult<String> {
    state.function_definition(id, oid).await
}

#[tauri::command]
pub async fn run_query(state: State<'_, AppState>, id: String, sql: String) -> AppResult<RunResult> {
    state.run_query(id, sql).await
}

#[tauri::command]
pub async fn cancel_query(state: State<'_, AppState>, id: String) -> AppResult<()> {
    state.cancel_query(id).await
}

#[tauri::command]
pub async fn get_read_only(state: State<'_, AppState>) -> AppResult<bool> {
    state.get_read_only().await
}

#[tauri::command]
pub async fn set_read_only(state: State<'_, AppState>, value: bool) -> AppResult<bool> {
    state.set_read_only(value).await
}

#[tauri::command]
pub async fn get_ai_settings(state: State<'_, AppState>) -> AppResult<Option<AiStatus>> {
    state.get_ai_settings().await
}

#[tauri::command]
pub async fn save_ai_settings(state: State<'_, AppState>, input: AiInput) -> AppResult<AiStatus> {
    state.save_ai_settings(input).await
}

#[tauri::command]
pub async fn test_ai(state: State<'_, AppState>, input: AiInput) -> AppResult<String> {
    state.test_ai(input).await
}

#[tauri::command]
pub async fn fix_sql(state: State<'_, AppState>, id: String, input: FixInput) -> AppResult<FixResult> {
    state.fix_sql(id, input).await
}
