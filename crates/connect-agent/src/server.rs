use crate::cloud::CloudControlClient;
use crate::watcher::CollectionWatchService;
use mdbase_connect_core::{CollectionRegistry, ConnectError};
use mdbase_connect_protocol::{
    AgentConnectionState, AgentStatus, ControlCommand, ControlError, ControlRequest,
    ControlResponse, RelayMessage, CONTROL_PROTOCOL_VERSION,
};
use std::io;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

pub struct AgentState {
    registry: CollectionRegistry,
    watcher: CollectionWatchService,
    connection_state: std::sync::RwLock<AgentConnectionState>,
    cloud: Option<CloudControlClient>,
}

impl AgentState {
    pub fn new(
        registry: CollectionRegistry,
        watcher: CollectionWatchService,
        cloud: Option<CloudControlClient>,
    ) -> Self {
        Self {
            registry,
            watcher,
            connection_state: std::sync::RwLock::new(AgentConnectionState::LocalOnly),
            cloud,
        }
    }

    fn refresh_watchers(&self) {
        match self.registry.list() {
            Ok(collections) => self.watcher.refresh(&collections),
            Err(error) => tracing::warn!(%error, "failed to refresh collection watchers"),
        }
    }

    pub fn set_connection_state(&self, state: AgentConnectionState) {
        *self
            .connection_state
            .write()
            .expect("connection state lock poisoned") = state;
    }

    pub fn collections(
        &self,
    ) -> Result<Vec<mdbase_connect_protocol::CollectionSummary>, ConnectError> {
        self.registry.list()
    }

    pub fn handle_relay_message(&self, message: RelayMessage) -> Option<RelayMessage> {
        match message {
            RelayMessage::PolicySnapshot { grants, .. } => {
                if let Err(error) = self.registry.replace_grants(&grants) {
                    tracing::error!(%error, "failed to apply relay policy snapshot");
                } else {
                    tracing::debug!(grants = grants.len(), "relay policy snapshot applied");
                }
                None
            }
            RelayMessage::OperationRequest {
                request_id,
                grant_id,
                collection_id,
                application_id,
                operation,
                input,
                ..
            } => {
                let context = self.registry.grant_context(grant_id).ok().flatten();
                let application_name = context
                    .as_ref()
                    .map(|grant| grant.application_name.as_str())
                    .unwrap_or("Unknown application");
                let collection_name = context
                    .as_ref()
                    .map(|grant| grant.collection_name.as_str())
                    .unwrap_or("Unknown collection");
                if self.registry.paused().unwrap_or(true) {
                    let _ = self.registry.record_activity(
                        application_id,
                        application_name,
                        collection_id,
                        collection_name,
                        &operation,
                        "denied",
                        Some("Remote access is paused"),
                    );
                    return Some(RelayMessage::OperationResponse {
                        protocol_version: CONTROL_PROTOCOL_VERSION,
                        request_id,
                        ok: false,
                        result: None,
                        error: Some(ControlError {
                            code: "access_paused".to_string(),
                            message: "Remote access is paused on this computer.".to_string(),
                            details: None,
                        }),
                    });
                }
                let authorized = context.as_ref().is_some_and(|grant| {
                    grant.application_id == application_id
                        && grant.collection_id == collection_id
                        && grant.operations.iter().any(|allowed| allowed == &operation)
                });
                let result = if authorized {
                    self.registry.scoped_operation(
                        collection_id,
                        &operation,
                        &input,
                        &context.as_ref().expect("authorized grant must exist").scope,
                    )
                } else {
                    let _ = self.registry.record_activity(
                        application_id,
                        application_name,
                        collection_id,
                        collection_name,
                        &operation,
                        "denied",
                        Some("Local grant did not allow this operation"),
                    );
                    return Some(RelayMessage::OperationResponse {
                        protocol_version: CONTROL_PROTOCOL_VERSION,
                        request_id,
                        ok: false,
                        result: None,
                        error: Some(ControlError {
                            code: "access_denied".to_string(),
                            message: "The local connector policy does not allow this request."
                                .to_string(),
                            details: None,
                        }),
                    });
                };
                if result.is_ok() && is_mutation(&operation) {
                    self.watcher.rescan(collection_id);
                }
                let (outcome, detail) = match &result {
                    Ok(_) => ("succeeded", None),
                    Err(error) => ("failed", Some(error.to_string())),
                };
                let _ = self.registry.record_activity(
                    application_id,
                    application_name,
                    collection_id,
                    collection_name,
                    &operation,
                    outcome,
                    detail.as_deref(),
                );
                Some(match result {
                    Ok(result) => RelayMessage::OperationResponse {
                        protocol_version: CONTROL_PROTOCOL_VERSION,
                        request_id,
                        ok: true,
                        result: Some(result),
                        error: None,
                    },
                    Err(error) => RelayMessage::OperationResponse {
                        protocol_version: CONTROL_PROTOCOL_VERSION,
                        request_id,
                        ok: false,
                        result: None,
                        error: Some(ControlError {
                            code: error.code().to_string(),
                            message: error.to_string(),
                            details: None,
                        }),
                    },
                })
            }
            RelayMessage::OperationResponse { .. } => None,
        }
    }

    async fn execute(&self, request: ControlRequest) -> ControlResponse {
        let id = request.id;
        let result = match request.command {
            ControlCommand::Ping => Ok(serde_json::json!({ "pong": true })),
            ControlCommand::Status => self.registry.count().map(|registered_collections| {
                serde_json::to_value(AgentStatus {
                    protocol_version: CONTROL_PROTOCOL_VERSION,
                    state: self
                        .connection_state
                        .read()
                        .expect("connection state lock poisoned")
                        .clone(),
                    registered_collections,
                    paused: self.registry.paused().unwrap_or(true),
                })
                .expect("agent status must serialize")
            }),
            ControlCommand::CollectionList => self
                .registry
                .list()
                .and_then(|value| serde_json::to_value(value).map_err(ConnectError::from)),
            ControlCommand::CollectionAdd(params) => {
                let result = self.registry.add(params.path);
                if result.is_ok() {
                    self.refresh_watchers();
                }
                result.and_then(|value| serde_json::to_value(value).map_err(ConnectError::from))
            }
            ControlCommand::CollectionCreate(params) => {
                let result = self.registry.create(params.path, params.name.as_deref());
                if result.is_ok() {
                    self.refresh_watchers();
                }
                result.and_then(|value| serde_json::to_value(value).map_err(ConnectError::from))
            }
            ControlCommand::CollectionRemove(params) => {
                let result = self.registry.remove(params.collection_id);
                if result.is_ok() {
                    self.refresh_watchers();
                }
                result.and_then(|value| serde_json::to_value(value).map_err(ConnectError::from))
            }
            ControlCommand::CollectionValidate(params) => {
                self.registry.validate(params.collection_id)
            }
            ControlCommand::CollectionOperation(params) => {
                let result =
                    self.registry
                        .operation(params.collection_id, &params.operation, &params.input);
                if result.is_ok() && is_mutation(&params.operation) {
                    self.watcher.rescan(params.collection_id);
                }
                result
            }
            ControlCommand::AccessSnapshot => self.access_snapshot().await,
            ControlCommand::AccessPause(params) => self
                .registry
                .set_paused(params.paused)
                .map(|_| serde_json::json!({ "paused": params.paused })),
            ControlCommand::ApplicationDiscover(params) => match self.cloud() {
                Ok(cloud) => cloud.discover(&params).await,
                Err(error) => Err(error),
            },
            ControlCommand::GrantCreate(params) => match self.cloud() {
                Ok(cloud) => cloud.create_grant(&params).await,
                Err(error) => Err(error),
            },
            ControlCommand::GrantUpdate(params) => match self.cloud() {
                Ok(cloud) => cloud.update_grant(&params).await,
                Err(error) => Err(error),
            },
            ControlCommand::GrantRevoke(params) => match self.cloud() {
                Ok(cloud) => {
                    let result = cloud.revoke_grant(&params).await;
                    if result.is_ok() {
                        if let Ok(snapshot) = cloud.snapshot().await {
                            let _ = self.registry.replace_grant_summaries(&snapshot.grants);
                        }
                    }
                    result
                }
                Err(error) => Err(error),
            },
            ControlCommand::AuthorizationApprove(params) => {
                self.approve_authorization(&params).await
            }
            ControlCommand::AuthorizationDeny(params) => match self.cloud() {
                Ok(cloud) => cloud.deny_authorization(&params).await,
                Err(error) => Err(error),
            },
            ControlCommand::ActivityList(params) => self
                .registry
                .list_activity(params.limit)
                .and_then(|value| serde_json::to_value(value).map_err(ConnectError::from)),
        };

        match result {
            Ok(result) => ControlResponse::success(id, result),
            Err(error) => ControlResponse::failure(id, error.code(), error.to_string()),
        }
    }

    fn cloud(&self) -> Result<&CloudControlClient, ConnectError> {
        self.cloud.as_ref().ok_or_else(|| {
            ConnectError::Cloud("Connect this computer to a portal first.".to_string())
        })
    }

    async fn approve_authorization(
        &self,
        params: &mdbase_connect_protocol::AuthorizationApproveParams,
    ) -> Result<serde_json::Value, ConnectError> {
        let cloud = self.cloud()?;
        let snapshot = cloud.snapshot().await?;
        let pending = snapshot
            .pending_authorizations
            .iter()
            .find(|pending| pending.id == params.request_id)
            .ok_or_else(|| {
                ConnectError::Cloud("The authorization request is no longer available.".to_string())
            })?;
        if !self
            .registry
            .is_compatible(params.collection_id, &pending.requirements)?
        {
            return Err(ConnectError::AccessDenied(
                "This collection does not provide the contracts required by the application."
                    .to_string(),
            ));
        }
        cloud.approve_authorization(params).await
    }

    async fn access_snapshot(&self) -> Result<serde_json::Value, ConnectError> {
        let Some(cloud) = &self.cloud else {
            return serde_json::to_value(mdbase_connect_protocol::AccessSnapshot {
                configured: false,
                online: false,
                account: None,
                grants: self.registry.list_grants()?,
                pending_authorizations: Vec::new(),
            })
            .map_err(ConnectError::from);
        };
        let mut snapshot = match cloud.snapshot().await {
            Ok(snapshot) => {
                self.registry.replace_grant_summaries(&snapshot.grants)?;
                snapshot
            }
            Err(error) => {
                tracing::debug!(%error, "cloud control snapshot unavailable; using local cache");
                mdbase_connect_protocol::AccessSnapshot {
                    configured: true,
                    online: false,
                    account: None,
                    grants: self.registry.list_grants()?,
                    pending_authorizations: Vec::new(),
                }
            }
        };
        let collections = self.registry.list()?;
        for pending in &mut snapshot.pending_authorizations {
            pending.compatible_collection_ids = collections
                .iter()
                .filter_map(|collection| {
                    self.registry
                        .is_compatible(collection.id, &pending.requirements)
                        .ok()
                        .filter(|compatible| *compatible)
                        .map(|_| collection.id)
                })
                .collect();
        }
        serde_json::to_value(snapshot).map_err(ConnectError::from)
    }
}

fn is_mutation(operation: &str) -> bool {
    matches!(operation, "create" | "update" | "delete" | "rename")
}

async fn handle_stream<S>(stream: S, state: Arc<AgentState>) -> io::Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let (reader, mut writer) = tokio::io::split(stream);
    let mut lines = BufReader::new(reader).lines();
    while let Some(line) = lines.next_line().await? {
        let response = match serde_json::from_str::<ControlRequest>(&line) {
            Ok(request) => state.execute(request).await,
            Err(error) => ControlResponse::failure(
                uuid::Uuid::nil(),
                "invalid_request",
                format!("Invalid control request: {error}"),
            ),
        };
        let mut encoded = serde_json::to_vec(&response).map_err(io::Error::other)?;
        encoded.push(b'\n');
        writer.write_all(&encoded).await?;
    }
    Ok(())
}

#[cfg(unix)]
pub async fn serve(endpoint: &str, state: Arc<AgentState>) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;
    use tokio::net::UnixListener;

    let socket_path = Path::new(endpoint);
    if socket_path.exists() {
        match tokio::net::UnixStream::connect(socket_path).await {
            Ok(_) => {
                return Err(io::Error::new(
                    io::ErrorKind::AddrInUse,
                    "another MDBASE Connect agent is already running",
                ))
            }
            Err(_) => std::fs::remove_file(socket_path)?,
        }
    }
    if let Some(parent) = socket_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let listener = UnixListener::bind(socket_path)?;
    std::fs::set_permissions(socket_path, std::fs::Permissions::from_mode(0o600))?;

    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (stream, _) = accepted?;
                let state = state.clone();
                tokio::spawn(async move {
                    if let Err(error) = handle_stream(stream, state).await {
                        tracing::debug!(%error, "local control connection closed");
                    }
                });
            }
            _ = tokio::signal::ctrl_c() => {
                tracing::info!("stopping local connector agent");
                drop(listener);
                let _ = std::fs::remove_file(socket_path);
                return Ok(());
            }
        }
    }
}

#[cfg(windows)]
pub async fn serve(endpoint: &str, state: Arc<AgentState>) -> io::Result<()> {
    use tokio::net::windows::named_pipe::ServerOptions;

    loop {
        let server = ServerOptions::new().create(endpoint)?;
        tokio::select! {
            connected = server.connect() => {
                connected?;
                let state = state.clone();
                tokio::spawn(async move {
                    if let Err(error) = handle_stream(server, state).await {
                        tracing::debug!(%error, "local control connection closed");
                    }
                });
            }
            _ = tokio::signal::ctrl_c() => {
                tracing::info!("stopping local connector agent");
                return Ok(());
            }
        }
    }
}
