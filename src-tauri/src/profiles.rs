//! Saved connection profiles. Stored as JSON in the app's config directory.
//! Passwords are never written here — they live in the OS keychain (see
//! `secrets`), keyed by the profile id.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::db::SslMode;
use crate::error::{AppError, AppResult, ErrorKind};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    #[serde(default)]
    pub ssl_mode: SslMode,
}

#[derive(Serialize, Deserialize)]
struct ProfileFile {
    version: u32,
    connections: Vec<ConnectionProfile>,
}

pub struct ProfileStore {
    path: PathBuf,
    profiles: Mutex<Vec<ConnectionProfile>>,
}

impl ProfileStore {
    /// Loads profiles from `path`. A missing file means no profiles yet.
    pub fn load(path: PathBuf) -> AppResult<Self> {
        let profiles = match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str::<ProfileFile>(&text)
                .map_err(|e| config_error(&path, format!("is not valid JSON ({e})")))?
                .connections,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(config_error(&path, e.to_string())),
        };
        Ok(ProfileStore { path, profiles: Mutex::new(profiles) })
    }

    pub fn list(&self) -> Vec<ConnectionProfile> {
        self.profiles.lock().unwrap().clone()
    }

    pub fn get(&self, id: &str) -> AppResult<ConnectionProfile> {
        self.profiles
            .lock()
            .unwrap()
            .iter()
            .find(|p| p.id == id)
            .cloned()
            .ok_or_else(|| AppError::invalid("That connection no longer exists."))
    }

    /// Inserts or replaces the profile with the same id.
    pub fn upsert(&self, profile: ConnectionProfile) -> AppResult<()> {
        let mut profiles = self.profiles.lock().unwrap();
        let mut next = profiles.clone();
        match next.iter_mut().find(|p| p.id == profile.id) {
            Some(existing) => *existing = profile,
            None => next.push(profile),
        }
        self.persist(&next)?;
        *profiles = next;
        Ok(())
    }

    pub fn remove(&self, id: &str) -> AppResult<()> {
        let mut profiles = self.profiles.lock().unwrap();
        let next: Vec<_> = profiles.iter().filter(|p| p.id != id).cloned().collect();
        self.persist(&next)?;
        *profiles = next;
        Ok(())
    }

    fn persist(&self, profiles: &[ConnectionProfile]) -> AppResult<()> {
        let file = ProfileFile { version: 1, connections: profiles.to_vec() };
        write_json_atomic(&self.path, &file).map_err(|(path, reason)| config_error(&path, reason))
    }
}

fn config_error(path: &Path, reason: String) -> AppError {
    AppError::new(ErrorKind::Config, format!("Could not save connections to {}: {reason}", path.display()))
}

/// Writes atomically: a crash mid-write never leaves a truncated file. On
/// failure, returns the path that failed and why, for the caller's message.
pub(crate) fn write_json_atomic(path: &Path, value: &impl Serialize) -> Result<(), (PathBuf, String)> {
    let json = serde_json::to_string_pretty(value).expect("settings serialise");
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| (dir.to_owned(), e.to_string()))?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| (tmp.clone(), e.to_string()))?;
    std::fs::rename(&tmp, path).map_err(|e| (path.to_owned(), e.to_string()))?;
    Ok(())
}
