use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

pub const CONTROL_PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ControlRequest {
    pub id: Uuid,
    #[serde(flatten)]
    pub command: ControlCommand,
}

impl ControlRequest {
    pub fn new(command: ControlCommand) -> Self {
        Self {
            id: Uuid::new_v4(),
            command,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "method", content = "params")]
pub enum ControlCommand {
    #[serde(rename = "ping")]
    Ping,
    #[serde(rename = "status")]
    Status,
    #[serde(rename = "collections.list")]
    CollectionList,
    #[serde(rename = "collections.add")]
    CollectionAdd(CollectionPathParams),
    #[serde(rename = "collections.create")]
    CollectionCreate(CollectionCreateParams),
    #[serde(rename = "collections.remove")]
    CollectionRemove(CollectionIdParams),
    #[serde(rename = "collections.validate")]
    CollectionValidate(CollectionIdParams),
    #[serde(rename = "collections.operation")]
    CollectionOperation(CollectionOperationParams),
    #[serde(rename = "access.snapshot")]
    AccessSnapshot,
    #[serde(rename = "access.pause")]
    AccessPause(AccessPauseParams),
    #[serde(rename = "apps.discover")]
    ApplicationDiscover(ApplicationDiscoverParams),
    #[serde(rename = "grants.create")]
    GrantCreate(GrantCreateParams),
    #[serde(rename = "grants.update")]
    GrantUpdate(GrantUpdateParams),
    #[serde(rename = "grants.revoke")]
    GrantRevoke(GrantIdParams),
    #[serde(rename = "authorizations.approve")]
    AuthorizationApprove(AuthorizationApproveParams),
    #[serde(rename = "authorizations.deny")]
    AuthorizationDeny(AuthorizationIdParams),
    #[serde(rename = "activity.list")]
    ActivityList(ActivityListParams),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionPathParams {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionCreateParams {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionIdParams {
    pub collection_id: Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionOperationParams {
    pub collection_id: Uuid,
    pub operation: String,
    #[serde(default)]
    pub input: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccessPauseParams {
    pub paused: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApplicationDiscoverParams {
    pub manifest_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GrantCreateParams {
    pub application_id: Uuid,
    pub collection_id: Uuid,
    pub operations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GrantUpdateParams {
    pub grant_id: Uuid,
    pub operations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GrantIdParams {
    pub grant_id: Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthorizationApproveParams {
    pub request_id: Uuid,
    pub collection_id: Uuid,
    pub operations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthorizationIdParams {
    pub request_id: Uuid,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivityListParams {
    #[serde(default = "default_activity_limit")]
    pub limit: usize,
}

fn default_activity_limit() -> usize {
    100
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ControlResponse {
    pub id: Uuid,
    pub protocol_version: u32,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ControlError>,
}

impl ControlResponse {
    pub fn success(id: Uuid, result: impl Serialize) -> Self {
        match serde_json::to_value(result) {
            Ok(result) => Self {
                id,
                protocol_version: CONTROL_PROTOCOL_VERSION,
                ok: true,
                result: Some(result),
                error: None,
            },
            Err(error) => Self::failure(id, "serialization_failed", error.to_string()),
        }
    }

    pub fn failure(id: Uuid, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            id,
            protocol_version: CONTROL_PROTOCOL_VERSION,
            ok: false,
            result: None,
            error: Some(ControlError {
                code: code.into(),
                message: message.into(),
                details: None,
            }),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ControlError {
    pub code: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentStatus {
    pub protocol_version: u32,
    pub state: AgentConnectionState,
    pub registered_collections: usize,
    pub paused: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentConnectionState {
    LocalOnly,
    Connecting,
    Connected,
    Offline,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CollectionSummary {
    pub id: Uuid,
    pub display_name: String,
    pub path: String,
    pub spec_version: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApplicationSummary {
    pub id: Uuid,
    pub name: String,
    pub homepage: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GrantSummary {
    pub id: Uuid,
    pub application_id: Uuid,
    pub application_name: String,
    pub application_homepage: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub application_icon: Option<String>,
    pub collection_id: Uuid,
    pub collection_name: String,
    pub operations: Vec<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingAuthorization {
    pub id: Uuid,
    pub application_id: Uuid,
    pub application_name: String,
    pub application_homepage: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub application_icon: Option<String>,
    pub requested_operations: Vec<String>,
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectorAccount {
    pub connector_id: Uuid,
    pub connector_name: String,
    pub user_name: String,
    pub user_email: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccessSnapshot {
    pub configured: bool,
    pub online: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<ConnectorAccount>,
    pub grants: Vec<GrantSummary>,
    pub pending_authorizations: Vec<PendingAuthorization>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivityEntry {
    pub id: Uuid,
    pub application_id: Uuid,
    pub application_name: String,
    pub collection_id: Uuid,
    pub collection_name: String,
    pub operation: String,
    pub outcome: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GrantPolicy {
    pub id: Uuid,
    pub application_id: Uuid,
    pub collection_id: Uuid,
    pub operations: Vec<String>,
    #[serde(default = "default_application_name")]
    pub application_name: String,
    #[serde(default)]
    pub application_homepage: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub application_icon: Option<String>,
    #[serde(default = "default_collection_name")]
    pub collection_name: String,
    #[serde(default)]
    pub created_at: String,
}

fn default_application_name() -> String {
    "Application".to_string()
}

fn default_collection_name() -> String {
    "Collection".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RelayMessage {
    PolicySnapshot {
        protocol_version: u32,
        grants: Vec<GrantPolicy>,
    },
    OperationRequest {
        protocol_version: u32,
        request_id: Uuid,
        grant_id: Uuid,
        collection_id: Uuid,
        application_id: Uuid,
        operation: String,
        input: Value,
    },
    OperationResponse {
        protocol_version: u32,
        request_id: Uuid,
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<ControlError>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_request_has_stable_wire_shape() {
        let request = ControlRequest {
            id: Uuid::nil(),
            command: ControlCommand::CollectionList,
        };
        assert_eq!(
            serde_json::to_value(request).unwrap(),
            serde_json::json!({
                "id": "00000000-0000-0000-0000-000000000000",
                "method": "collections.list"
            })
        );
    }
}
