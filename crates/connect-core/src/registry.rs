use directories::ProjectDirs;
use mdbase::{Collection, SpecProfile};
use mdbase_connect_protocol::{ActivityEntry, CollectionSummary, GrantPolicy, GrantSummary};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
#[cfg(windows)]
use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use thiserror::Error;
use uuid::Uuid;

const COLLECTION_NAMESPACE: Uuid = Uuid::from_u128(0x72972de3_d05a_4db7_82f5_c9ce02f0fb1d);

#[derive(Debug, Error)]
pub enum ConnectError {
    #[error("MDBASE Connect could not determine a per-user state directory")]
    StateDirectoryUnavailable,
    #[error("Collection path does not exist: {0}")]
    PathNotFound(String),
    #[error("The selected folder is not an mdbase collection: {0}")]
    NotACollection(String),
    #[error("Collection is not registered: {0}")]
    CollectionNotFound(Uuid),
    #[error("Collection initialization failed: {0}")]
    CollectionInit(String),
    #[error("Collection failed to open: {0}")]
    CollectionOpen(String),
    #[error("Unsupported collection operation: {0}")]
    UnsupportedOperation(String),
    #[error("Local registry error: {0}")]
    Registry(#[from] rusqlite::Error),
    #[error("Filesystem error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Configuration error: {0}")]
    Config(#[from] serde_yaml::Error),
    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("Cloud control error: {0}")]
    Cloud(String),
}

impl ConnectError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::StateDirectoryUnavailable => "state_directory_unavailable",
            Self::PathNotFound(_) => "path_not_found",
            Self::NotACollection(_) => "not_a_collection",
            Self::CollectionNotFound(_) => "collection_not_found",
            Self::CollectionInit(_) => "collection_init_failed",
            Self::CollectionOpen(_) => "collection_open_failed",
            Self::UnsupportedOperation(_) => "unsupported_operation",
            Self::Registry(_) => "registry_failed",
            Self::Io(_) => "io_failed",
            Self::Config(_) => "invalid_config",
            Self::Serialization(_) => "serialization_failed",
            Self::Cloud(_) => "cloud_control_failed",
        }
    }
}

pub fn default_state_dir() -> Result<PathBuf, ConnectError> {
    if let Some(path) = env::var_os("MDBASE_CONNECT_HOME") {
        return Ok(PathBuf::from(path));
    }
    ProjectDirs::from("dev", "mdbase", "connect")
        .map(|dirs| dirs.data_local_dir().to_path_buf())
        .ok_or(ConnectError::StateDirectoryUnavailable)
}

pub fn default_control_endpoint(state_dir: &Path) -> String {
    if let Some(endpoint) = env::var_os("MDBASE_CONNECT_SOCKET") {
        return endpoint.to_string_lossy().to_string();
    }
    #[cfg(unix)]
    {
        state_dir.join("agent.sock").to_string_lossy().to_string()
    }
    #[cfg(windows)]
    {
        let digest = Sha256::digest(state_dir.to_string_lossy().as_bytes());
        let suffix = digest[..8]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        format!(r"\\.\pipe\mdbase-connect-{suffix}")
    }
}

#[derive(Debug, Clone)]
pub struct CollectionRegistry {
    db_path: PathBuf,
}

impl CollectionRegistry {
    pub fn open(state_dir: impl AsRef<Path>) -> Result<Self, ConnectError> {
        fs::create_dir_all(state_dir.as_ref())?;
        let registry = Self {
            db_path: state_dir.as_ref().join("connector.sqlite"),
        };
        registry.migrate()?;
        Ok(registry)
    }

    fn connection(&self) -> Result<Connection, ConnectError> {
        let connection = Connection::open(&self.db_path)?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        Ok(connection)
    }

    fn migrate(&self) -> Result<(), ConnectError> {
        self.connection()?.execute_batch(
            "
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS collections (
                id TEXT PRIMARY KEY,
                path TEXT NOT NULL UNIQUE,
                display_name TEXT NOT NULL,
                spec_version TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS grants (
                id TEXT PRIMARY KEY,
                application_id TEXT NOT NULL,
                collection_id TEXT NOT NULL,
                operations TEXT NOT NULL,
                application_name TEXT NOT NULL DEFAULT 'Application',
                application_homepage TEXT NOT NULL DEFAULT '',
                application_icon TEXT,
                collection_name TEXT NOT NULL DEFAULT 'Collection',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS activity (
                id TEXT PRIMARY KEY,
                application_id TEXT NOT NULL,
                application_name TEXT NOT NULL,
                collection_id TEXT NOT NULL,
                collection_name TEXT NOT NULL,
                operation TEXT NOT NULL,
                outcome TEXT NOT NULL,
                detail TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            ",
        )?;
        // These upgrades preserve registries created by the first development MVP.
        let connection = self.connection()?;
        for migration in [
            "ALTER TABLE grants ADD COLUMN application_name TEXT NOT NULL DEFAULT 'Application'",
            "ALTER TABLE grants ADD COLUMN application_homepage TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE grants ADD COLUMN application_icon TEXT",
            "ALTER TABLE grants ADD COLUMN collection_name TEXT NOT NULL DEFAULT 'Collection'",
            "ALTER TABLE grants ADD COLUMN created_at TEXT NOT NULL DEFAULT ''",
        ] {
            if let Err(error) = connection.execute(migration, []) {
                if !error.to_string().contains("duplicate column name") {
                    return Err(error.into());
                }
            }
        }
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<CollectionSummary>, ConnectError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, display_name, path, spec_version, enabled
             FROM collections ORDER BY display_name COLLATE NOCASE, path",
        )?;
        let rows = statement.query_map([], |row| {
            let id: String = row.get(0)?;
            Ok((
                id,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, bool>(4)?,
            ))
        })?;

        rows.map(|row| {
            let (id, display_name, path, spec_version, enabled) = row?;
            let id = Uuid::parse_str(&id).map_err(|error| {
                ConnectError::CollectionOpen(format!("invalid collection id in registry: {error}"))
            })?;
            Ok(CollectionSummary {
                id,
                display_name,
                path,
                spec_version,
                enabled,
            })
        })
        .collect()
    }

    pub fn count(&self) -> Result<usize, ConnectError> {
        let count: i64 =
            self.connection()?
                .query_row("SELECT COUNT(*) FROM collections", [], |row| row.get(0))?;
        Ok(count as usize)
    }

    pub fn add(&self, path: impl AsRef<Path>) -> Result<CollectionSummary, ConnectError> {
        let requested_path = path.as_ref();
        if !requested_path.exists() {
            return Err(ConnectError::PathNotFound(
                requested_path.display().to_string(),
            ));
        }
        let path = requested_path.canonicalize()?;
        if !path.join("mdbase.yaml").is_file() {
            return Err(ConnectError::NotACollection(path.display().to_string()));
        }

        Collection::open(&path).map_err(|error| {
            ConnectError::CollectionOpen(error_message(&error, "Failed to open collection"))
        })?;

        let metadata = read_collection_metadata(&path)?;
        let path_string = path.to_string_lossy().to_string();
        let id = Uuid::new_v5(&COLLECTION_NAMESPACE, path_string.as_bytes());
        let display_name = metadata
            .name
            .or_else(|| {
                path.file_name()
                    .map(|name| name.to_string_lossy().to_string())
            })
            .unwrap_or_else(|| "Collection".to_string());

        self.connection()?.execute(
            "INSERT INTO collections (id, path, display_name, spec_version, enabled)
             VALUES (?1, ?2, ?3, ?4, 1)
             ON CONFLICT(path) DO UPDATE SET
               display_name = excluded.display_name,
               spec_version = excluded.spec_version,
               updated_at = CURRENT_TIMESTAMP",
            params![
                id.to_string(),
                path_string,
                display_name,
                metadata.spec_version
            ],
        )?;

        self.get(id)
    }

    pub fn create(
        &self,
        path: impl AsRef<Path>,
        name: Option<&str>,
    ) -> Result<CollectionSummary, ConnectError> {
        let mut config = serde_json::Map::new();
        config.insert("spec_version".to_string(), json!("0.3.0"));
        if let Some(name) = name.filter(|name| !name.trim().is_empty()) {
            config.insert("name".to_string(), json!(name.trim()));
        }
        let result = mdbase::init::init_collection(
            path.as_ref(),
            &json!({ "config": Value::Object(config) }),
        );
        if result.get("error").is_some() {
            return Err(ConnectError::CollectionInit(error_message(
                &result,
                "Failed to initialize collection",
            )));
        }
        self.add(path)
    }

    pub fn get(&self, id: Uuid) -> Result<CollectionSummary, ConnectError> {
        let connection = self.connection()?;
        let row = connection
            .query_row(
                "SELECT display_name, path, spec_version, enabled
                 FROM collections WHERE id = ?1",
                [id.to_string()],
                |row| {
                    Ok(CollectionSummary {
                        id,
                        display_name: row.get(0)?,
                        path: row.get(1)?,
                        spec_version: row.get(2)?,
                        enabled: row.get(3)?,
                    })
                },
            )
            .optional()?;
        row.ok_or(ConnectError::CollectionNotFound(id))
    }

    pub fn remove(&self, id: Uuid) -> Result<CollectionSummary, ConnectError> {
        let collection = self.get(id)?;
        self.connection()?
            .execute("DELETE FROM collections WHERE id = ?1", [id.to_string()])?;
        Ok(collection)
    }

    pub fn validate(&self, id: Uuid) -> Result<Value, ConnectError> {
        self.operation(id, "validate", &json!({}))
    }

    pub fn operation(
        &self,
        id: Uuid,
        operation: &str,
        input: &Value,
    ) -> Result<Value, ConnectError> {
        let registered = self.get(id)?;
        let collection = Collection::open(Path::new(&registered.path)).map_err(|error| {
            ConnectError::CollectionOpen(error_message(&error, "Failed to open collection"))
        })?;

        if operation == "query" {
            return Ok(collection.query(input));
        }

        if collection.spec_profile == SpecProfile::V03 {
            let operations = collection
                .v03_operations()
                .map_err(|diagnostic| ConnectError::CollectionOpen(diagnostic.message.clone()))?;
            let result = match operation {
                "read" => operations.read(input),
                "validate" => operations.validate(input),
                "create" => operations.create(input),
                "update" => operations.update(input),
                "delete" => operations.delete(input),
                "rename" => operations.rename(input),
                other => return Err(ConnectError::UnsupportedOperation(other.to_string())),
            };
            return Ok(serde_json::to_value(result)?);
        }

        Ok(match operation {
            "read" => collection.read(input),
            "validate" => collection.validate_op(input),
            "create" => collection.create(input),
            "update" => collection.update(input),
            "delete" => collection.delete(input),
            "rename" => collection.rename(input),
            other => return Err(ConnectError::UnsupportedOperation(other.to_string())),
        })
    }

    pub fn replace_grants(&self, grants: &[GrantPolicy]) -> Result<(), ConnectError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction()?;
        transaction.execute("DELETE FROM grants", [])?;
        {
            let mut statement = transaction.prepare(
                "INSERT INTO grants
                   (id, application_id, collection_id, operations, application_name,
                    application_homepage, application_icon, collection_name, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            )?;
            for grant in grants {
                statement.execute(params![
                    grant.id.to_string(),
                    grant.application_id.to_string(),
                    grant.collection_id.to_string(),
                    serde_json::to_string(&grant.operations)?,
                    grant.application_name,
                    grant.application_homepage,
                    grant.application_icon,
                    grant.collection_name,
                    grant.created_at,
                ])?;
            }
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn replace_grant_summaries(&self, grants: &[GrantSummary]) -> Result<(), ConnectError> {
        self.replace_grants(
            &grants
                .iter()
                .map(|grant| GrantPolicy {
                    id: grant.id,
                    application_id: grant.application_id,
                    collection_id: grant.collection_id,
                    operations: grant.operations.clone(),
                    application_name: grant.application_name.clone(),
                    application_homepage: grant.application_homepage.clone(),
                    application_icon: grant.application_icon.clone(),
                    collection_name: grant.collection_name.clone(),
                    created_at: grant.created_at.clone(),
                })
                .collect::<Vec<_>>(),
        )
    }

    pub fn list_grants(&self) -> Result<Vec<GrantSummary>, ConnectError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, application_id, application_name, application_homepage,
                    application_icon, collection_id, collection_name, operations, created_at
             FROM grants ORDER BY application_name COLLATE NOCASE, collection_name COLLATE NOCASE",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
            ))
        })?;
        rows.map(|row| {
            let (
                id,
                application_id,
                application_name,
                application_homepage,
                application_icon,
                collection_id,
                collection_name,
                operations,
                created_at,
            ) = row?;
            Ok(GrantSummary {
                id: parse_registry_uuid(&id)?,
                application_id: parse_registry_uuid(&application_id)?,
                application_name,
                application_homepage,
                application_icon,
                collection_id: parse_registry_uuid(&collection_id)?,
                collection_name,
                operations: serde_json::from_str(&operations)?,
                created_at,
            })
        })
        .collect()
    }

    pub fn set_paused(&self, paused: bool) -> Result<(), ConnectError> {
        self.connection()?.execute(
            "INSERT INTO settings (key, value) VALUES ('access_paused', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP",
            [if paused { "true" } else { "false" }],
        )?;
        Ok(())
    }

    pub fn paused(&self) -> Result<bool, ConnectError> {
        let value = self
            .connection()?
            .query_row(
                "SELECT value FROM settings WHERE key = 'access_paused'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        Ok(value.as_deref() == Some("true"))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn record_activity(
        &self,
        application_id: Uuid,
        application_name: &str,
        collection_id: Uuid,
        collection_name: &str,
        operation: &str,
        outcome: &str,
        detail: Option<&str>,
    ) -> Result<(), ConnectError> {
        self.connection()?.execute(
            "INSERT INTO activity
               (id, application_id, application_name, collection_id, collection_name,
                operation, outcome, detail)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                Uuid::new_v4().to_string(),
                application_id.to_string(),
                application_name,
                collection_id.to_string(),
                collection_name,
                operation,
                outcome,
                detail,
            ],
        )?;
        Ok(())
    }

    pub fn list_activity(&self, limit: usize) -> Result<Vec<ActivityEntry>, ConnectError> {
        let connection = self.connection()?;
        let mut statement = connection.prepare(
            "SELECT id, application_id, application_name, collection_id, collection_name,
                    operation, outcome, detail, created_at
             FROM activity ORDER BY created_at DESC, rowid DESC LIMIT ?1",
        )?;
        let rows = statement.query_map([limit.clamp(1, 500) as i64], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, String>(8)?,
            ))
        })?;
        rows.map(|row| {
            let (
                id,
                application_id,
                application_name,
                collection_id,
                collection_name,
                operation,
                outcome,
                detail,
                created_at,
            ) = row?;
            Ok(ActivityEntry {
                id: parse_registry_uuid(&id)?,
                application_id: parse_registry_uuid(&application_id)?,
                application_name,
                collection_id: parse_registry_uuid(&collection_id)?,
                collection_name,
                operation,
                outcome,
                detail,
                created_at,
            })
        })
        .collect()
    }

    pub fn grant_context(&self, grant_id: Uuid) -> Result<Option<GrantSummary>, ConnectError> {
        Ok(self
            .list_grants()?
            .into_iter()
            .find(|grant| grant.id == grant_id))
    }

    pub fn authorizes(
        &self,
        grant_id: Uuid,
        application_id: Uuid,
        collection_id: Uuid,
        operation: &str,
    ) -> Result<bool, ConnectError> {
        let operations = self
            .connection()?
            .query_row(
                "SELECT operations FROM grants
                 WHERE id = ?1 AND application_id = ?2 AND collection_id = ?3",
                params![
                    grant_id.to_string(),
                    application_id.to_string(),
                    collection_id.to_string()
                ],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        let Some(operations) = operations else {
            return Ok(false);
        };
        let operations: Vec<String> = serde_json::from_str(&operations)?;
        Ok(operations.iter().any(|allowed| allowed == operation))
    }
}

fn parse_registry_uuid(value: &str) -> Result<Uuid, ConnectError> {
    Uuid::parse_str(value).map_err(|error| {
        ConnectError::CollectionOpen(format!("invalid UUID in connector registry: {error}"))
    })
}

#[derive(Debug, serde::Deserialize)]
struct CollectionMetadata {
    spec_version: String,
    #[serde(default)]
    name: Option<String>,
}

fn read_collection_metadata(root: &Path) -> Result<CollectionMetadata, ConnectError> {
    let source = fs::read_to_string(root.join("mdbase.yaml"))?;
    Ok(serde_yaml::from_str(&source)?)
}

fn error_message(value: &Value, fallback: &str) -> String {
    value
        .pointer("/error/message")
        .or_else(|| value.get("message"))
        .and_then(Value::as_str)
        .unwrap_or(fallback)
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn create_register_list_and_remove_collection() {
        let state = tempdir().unwrap();
        let collection_parent = tempdir().unwrap();
        let root = collection_parent.path().join("workouts");
        let registry = CollectionRegistry::open(state.path()).unwrap();

        let created = registry.create(&root, Some("Workouts")).unwrap();
        assert_eq!(created.display_name, "Workouts");
        assert_eq!(created.spec_version, "0.3.0");
        assert!(root.join("mdbase.yaml").exists());
        assert!(root.join("_types").is_dir());

        let listed = registry.list().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, created.id);

        let removed = registry.remove(created.id).unwrap();
        assert_eq!(removed.id, created.id);
        assert!(
            root.exists(),
            "unregistering must not delete collection files"
        );
        assert!(registry.list().unwrap().is_empty());
    }

    #[test]
    fn generic_operation_uses_v03_envelope() {
        let state = tempdir().unwrap();
        let collection_parent = tempdir().unwrap();
        let root = collection_parent.path().join("notes");
        let registry = CollectionRegistry::open(state.path()).unwrap();
        let collection = registry.create(&root, Some("Notes")).unwrap();

        let result = registry
            .operation(
                collection.id,
                "create",
                &json!({
                    "path": "hello.md",
                    "frontmatter": { "title": "Hello" },
                    "body": "World"
                }),
            )
            .unwrap();
        assert_eq!(result["valid"], true);
        assert!(result["result"]["revision"].as_str().is_some());

        let read = registry
            .operation(collection.id, "read", &json!({ "path": "hello.md" }))
            .unwrap();
        assert_eq!(read["valid"], true);
        assert_eq!(read["result"]["frontmatter"]["title"], "Hello");
    }

    #[test]
    fn policy_snapshot_replaces_previous_local_authority() {
        let state = tempdir().unwrap();
        let registry = CollectionRegistry::open(state.path()).unwrap();
        let grant = GrantPolicy {
            id: Uuid::new_v4(),
            application_id: Uuid::new_v4(),
            collection_id: Uuid::new_v4(),
            operations: vec!["read".to_string(), "query".to_string()],
            application_name: "Workout Tracker".to_string(),
            application_homepage: "https://workouts.example".to_string(),
            application_icon: None,
            collection_name: "Workouts".to_string(),
            created_at: "2026-07-19T00:00:00Z".to_string(),
        };
        registry
            .replace_grants(std::slice::from_ref(&grant))
            .unwrap();
        assert!(registry
            .authorizes(grant.id, grant.application_id, grant.collection_id, "query")
            .unwrap());
        assert!(!registry
            .authorizes(
                grant.id,
                grant.application_id,
                grant.collection_id,
                "update"
            )
            .unwrap());

        registry.replace_grants(&[]).unwrap();
        assert!(!registry
            .authorizes(grant.id, grant.application_id, grant.collection_id, "read")
            .unwrap());
    }
}
