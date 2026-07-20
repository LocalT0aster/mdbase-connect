use mdbase::watch::CollectionWatcher;
use mdbase_connect_core::CollectionRegistry;
use mdbase_connect_protocol::CollectionSummary;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;
use uuid::Uuid;

#[derive(Clone)]
pub struct CollectionWatchService {
    commands: mpsc::Sender<WatchCommand>,
}

enum WatchCommand {
    Refresh(Vec<CollectionSummary>),
}

struct WatchWorker {
    stop: mpsc::Sender<()>,
    worker: thread::JoinHandle<()>,
}

impl CollectionWatchService {
    pub fn start(registry: CollectionRegistry) -> Self {
        let (commands, receiver) = mpsc::channel();
        thread::Builder::new()
            .name("mdbase-connect-watch-supervisor".to_string())
            .spawn(move || watch_supervisor(registry, receiver))
            .expect("failed to start collection watcher supervisor");
        Self { commands }
    }

    pub fn refresh(&self, collections: &[CollectionSummary]) {
        if let Err(error) = self.commands.send(WatchCommand::Refresh(
            collections
                .iter()
                .filter(|collection| collection.enabled)
                .cloned()
                .collect(),
        )) {
            tracing::warn!(%error, "collection watcher is unavailable");
        }
    }
}

fn watch_supervisor(registry: CollectionRegistry, commands: mpsc::Receiver<WatchCommand>) {
    let mut workers: HashMap<Uuid, WatchWorker> = HashMap::new();
    while let Ok(command) = commands.recv() {
        match command {
            WatchCommand::Refresh(collections) => {
                refresh_workers(&registry, &mut workers, collections)
            }
        }
    }
    for (_, worker) in workers {
        stop_worker(worker);
    }
}

fn refresh_workers(
    registry: &CollectionRegistry,
    workers: &mut HashMap<Uuid, WatchWorker>,
    collections: Vec<CollectionSummary>,
) {
    let requested = collections
        .iter()
        .map(|collection| collection.id)
        .collect::<HashSet<_>>();
    for removed in workers
        .keys()
        .filter(|id| !requested.contains(id))
        .copied()
        .collect::<Vec<_>>()
    {
        if let Some(worker) = workers.remove(&removed) {
            stop_worker(worker);
        }
    }
    for collection in collections {
        workers.entry(collection.id).or_insert_with(|| {
            start_worker(
                registry.clone(),
                collection.id,
                PathBuf::from(collection.path),
            )
        });
    }
}

fn start_worker(registry: CollectionRegistry, collection_id: Uuid, root: PathBuf) -> WatchWorker {
    let (stop, stop_rx) = mpsc::channel();
    let worker = thread::Builder::new()
        .name(format!("mdbase-connect-watch-{collection_id}"))
        .spawn(move || {
            let watcher = match CollectionWatcher::open(&root, Duration::from_millis(120)) {
                Ok(watcher) => watcher,
                Err(error) => {
                    tracing::error!(collection_id = %collection_id, path = %root.display(), %error, "failed to watch collection");
                    return;
                }
            };
            loop {
                if stop_rx.try_recv().is_ok() {
                    return;
                }
                match watcher.recv_timeout(Duration::from_millis(100)) {
                    Ok(Some(event)) => {
                        if let Err(error) = registry.append_change(collection_id, &event) {
                            tracing::warn!(collection_id = %collection_id, %error, "failed to persist collection change");
                        } else {
                            tracing::debug!(collection_id = %collection_id, event_type = %event.event_type, sequence = event.sequence, "collection change recorded");
                        }
                    }
                    Ok(None) => {}
                    Err(error) => {
                        tracing::warn!(collection_id = %collection_id, %error, "collection watcher stopped");
                        return;
                    }
                }
            }
        })
        .expect("failed to start collection watcher thread");
    WatchWorker { stop, worker }
}

fn stop_worker(worker: WatchWorker) {
    let _ = worker.stop.send(());
    let _ = worker.worker.join();
}
