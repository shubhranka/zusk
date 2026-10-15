//! Browser dev bridge: serves the app's commands over HTTP on 127.0.0.1:1421
//! so the UI can be developed in a normal browser (`npm run dev`, then open
//! http://localhost:1420) against the real Rust backend.
//!
//!   cargo run --manifest-path src-tauri/Cargo.toml --example dev_bridge
//!
//! Development only: it listens on loopback, accepts requests from the Vite
//! origin, keeps passwords and API keys in memory (not the keychain) and
//! stores its connection list and AI settings in a temp directory, separate
//! from the desktop app.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use zusk_lib::ai::{AiInput, AiStore, ChatInput, FixInput};
use zusk_lib::commands::{AppState, ConnectionInput};
use zusk_lib::error::{AppError, AppResult};
use zusk_lib::profiles::ProfileStore;
use zusk_lib::secrets;
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::Value;
use tower_http::cors::CorsLayer;

#[derive(Deserialize)]
struct IdArg {
    id: String,
}

#[derive(Deserialize)]
struct InputArg {
    input: ConnectionInput,
}

#[derive(Deserialize)]
struct SchemaArg {
    id: String,
    schema: String,
}

#[derive(Deserialize)]
struct TableArg {
    id: String,
    schema: String,
    name: String,
}

#[derive(Deserialize)]
struct OidArg {
    id: String,
    oid: u32,
}

#[derive(Deserialize)]
struct SqlArg {
    id: String,
    sql: String,
}

#[derive(Deserialize)]
struct TemplateArg {
    sql: String,
    vars: Value,
}

#[derive(Deserialize)]
struct ValueArg {
    value: bool,
}

#[derive(Deserialize)]
struct AiInputArg {
    input: AiInput,
}

#[derive(Deserialize)]
struct FixArg {
    id: String,
    input: FixInput,
}

#[derive(Deserialize)]
struct ChatArg {
    id: Option<String>,
    input: ChatInput,
}

fn args<T: DeserializeOwned>(value: Value) -> AppResult<T> {
    serde_json::from_value(value).map_err(|e| AppError::invalid(format!("Bad arguments: {e}")))
}

fn json<T: serde::Serialize>(value: AppResult<T>) -> AppResult<Value> {
    value.map(|v| serde_json::to_value(v).expect("serialisable"))
}

async fn dispatch(state: &AppState, command: &str, a: Value) -> AppResult<Value> {
    match command {
        "list_connections" => json(state.list_connections().await),
        "save_connection" => json(state.save_connection(args::<InputArg>(a)?.input).await),
        "delete_connection" => json(state.delete_connection(args::<IdArg>(a)?.id).await),
        "test_connection" => json(state.test_connection(args::<InputArg>(a)?.input).await),
        "connect" => json(state.connect(args::<IdArg>(a)?.id).await),
        "disconnect" => json(state.disconnect(args::<IdArg>(a)?.id).await),
        "list_schemas" => json(state.list_schemas(args::<IdArg>(a)?.id).await),
        "list_schema_objects" => {
            let a: SchemaArg = args(a)?;
            json(state.list_schema_objects(a.id, a.schema).await)
        }
        "describe_table" => {
            let a: TableArg = args(a)?;
            json(state.describe_table(a.id, a.schema, a.name).await)
        }
        "list_relations" => json(state.list_relations(args::<IdArg>(a)?.id).await),
        "function_definition" => {
            let a: OidArg = args(a)?;
            json(state.function_definition(a.id, a.oid).await)
        }
        "render_template" => {
            let a: TemplateArg = args(a)?;
            json(state.render_template(a.sql, a.vars).await)
        }
        "run_query" => {
            let a: SqlArg = args(a)?;
            json(state.run_query(a.id, a.sql).await)
        }
        "cancel_query" => json(state.cancel_query(args::<IdArg>(a)?.id).await),
        "get_read_only" => json(state.get_read_only().await),
        "set_read_only" => json(state.set_read_only(args::<ValueArg>(a)?.value).await),
        "get_ai_settings" => json(state.get_ai_settings().await),
        "save_ai_settings" => json(state.save_ai_settings(args::<AiInputArg>(a)?.input).await),
        "test_ai" => json(state.test_ai(args::<AiInputArg>(a)?.input).await),
        "fix_sql" => {
            let a: FixArg = args(a)?;
            json(state.fix_sql(a.id, a.input).await)
        }
        "chat_sql" => {
            let a: ChatArg = args(a)?;
            json(state.chat_sql(a.id, a.input).await)
        }
        other => Err(AppError::invalid(format!("Unknown command {other}"))),
    }
}

async fn invoke(State(state): State<Arc<AppState>>, Path(command): Path<String>, Json(a): Json<Value>) -> Response {
    match dispatch(&state, &command, a).await {
        Ok(value) => Json(value).into_response(),
        Err(err) => (StatusCode::UNPROCESSABLE_ENTITY, Json(err)).into_response(),
    }
}

#[tokio::main]
async fn main() {
    secrets::use_memory_store();
    let dir = std::env::temp_dir().join("zusk-dev-bridge");
    let profiles = ProfileStore::load(dir.join("connections.json")).expect("profile store");
    let ai = AiStore::load(dir.join("llm.json"));
    let state = Arc::new(AppState::new(profiles, ai));

    let cors = CorsLayer::new()
        .allow_origin(["http://localhost:1420".parse::<HeaderValue>().unwrap(), "http://127.0.0.1:1420".parse().unwrap()])
        .allow_methods([Method::POST])
        .allow_headers([axum::http::header::CONTENT_TYPE]);
    let app = Router::new().route("/invoke/{command}", post(invoke)).with_state(state).layer(cors);

    let addr = SocketAddr::from(([127, 0, 0, 1], 1421));
    println!("Zusk dev bridge on http://{addr} (profiles in {})", dir.display());
    let listener = tokio::net::TcpListener::bind(addr).await.expect("port 1421 is free");
    axum::serve(listener, app).await.unwrap();
}
