mod cloud;
mod relay;
mod server;
mod watcher;

use clap::Parser;
use cloud::CloudControlClient;
use mdbase_connect_core::{default_control_endpoint, default_state_dir, CollectionRegistry};
use server::AgentState;
use std::path::PathBuf;
use std::sync::Arc;
use tracing_subscriber::EnvFilter;
use watcher::CollectionWatchService;

#[derive(Debug, Parser)]
#[command(name = "mdbase-connect-agent")]
#[command(about = "Local MDBASE Connect agent")]
struct Args {
    /// Override the per-user connector state directory.
    #[arg(long, env = "MDBASE_CONNECT_HOME")]
    state_dir: Option<PathBuf>,

    /// Override the Unix socket path or Windows named pipe.
    #[arg(long, env = "MDBASE_CONNECT_SOCKET")]
    endpoint: Option<String>,

    /// Hosted or self-hosted MDBASE Connect server URL.
    #[arg(long, env = "MDBASE_CONNECT_SERVER_URL")]
    server_url: Option<String>,

    /// One-time connector credential created in the user portal.
    #[arg(long, env = "MDBASE_CONNECT_CONNECTOR_TOKEN")]
    connector_token: Option<String>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .compact()
        .init();

    let args = Args::parse();
    let state_dir = args.state_dir.map(Ok).unwrap_or_else(default_state_dir)?;
    let endpoint = args
        .endpoint
        .unwrap_or_else(|| default_control_endpoint(&state_dir));
    let registry = CollectionRegistry::open(&state_dir)?;
    let watcher = CollectionWatchService::start();
    watcher.refresh(&registry.list()?);

    let cloud = match (args.server_url.clone(), args.connector_token.clone()) {
        (Some(server_url), Some(connector_token)) => {
            Some(CloudControlClient::new(server_url, connector_token))
        }
        (None, None) => None,
        _ => {
            return Err(
                "Both --server-url and --connector-token are required for cloud relay".into(),
            )
        }
    };
    let state = Arc::new(AgentState::new(registry, watcher, cloud));
    match (args.server_url, args.connector_token) {
        (Some(server_url), Some(connector_token)) => {
            tokio::spawn(relay::run(server_url, connector_token, state.clone()));
        }
        (None, None) => {}
        _ => unreachable!("cloud arguments were validated above"),
    }
    tracing::info!(%endpoint, state_dir = %state_dir.display(), "starting local connector agent");
    server::serve(&endpoint, state).await?;
    Ok(())
}
