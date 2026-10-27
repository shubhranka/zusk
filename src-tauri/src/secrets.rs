//! Secrets in the OS keychain (macOS Keychain, Windows Credential Manager,
//! Secret Service on Linux). One entry per account: connection passwords use
//! the profile id, AI provider keys use "ai:<provider>".
//!
//! The browser dev bridge (examples/dev_bridge.rs) switches to an in-memory
//! store instead; the desktop app always uses the keychain.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use keyring::Entry;

use crate::error::AppResult;

const SERVICE: &str = "dev.zusk.app";

static MEMORY: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

/// Keeps passwords in process memory only. For the dev bridge; never call
/// this from the app.
pub fn use_memory_store() {
    let _ = MEMORY.set(Mutex::new(HashMap::new()));
}

fn entry(account: &str) -> AppResult<Entry> {
    Ok(Entry::new(SERVICE, account)?)
}

pub fn get_password(account: &str) -> AppResult<Option<String>> {
    if let Some(memory) = MEMORY.get() {
        return Ok(memory.lock().unwrap().get(account).cloned());
    }
    match entry(account)?.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn set_password(account: &str, password: &str) -> AppResult<()> {
    if let Some(memory) = MEMORY.get() {
        memory.lock().unwrap().insert(account.to_owned(), password.to_owned());
        return Ok(());
    }
    Ok(entry(account)?.set_password(password)?)
}

pub fn delete_password(account: &str) -> AppResult<()> {
    if let Some(memory) = MEMORY.get() {
        memory.lock().unwrap().remove(account);
        return Ok(());
    }
    match entry(account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Writes, reads and deletes a real keychain entry. Ignored by default
    /// because it touches the login keychain.
    #[test]
    #[ignore = "touches the OS keychain"]
    fn round_trips_through_the_os_keychain() {
        let id = format!("test-{}", uuid::Uuid::new_v4());
        assert_eq!(get_password(&id).unwrap(), None);
        set_password(&id, "s3cret ✓").unwrap();
        assert_eq!(get_password(&id).unwrap().as_deref(), Some("s3cret ✓"));
        delete_password(&id).unwrap();
        assert_eq!(get_password(&id).unwrap(), None);
        delete_password(&id).unwrap();
    }
}
