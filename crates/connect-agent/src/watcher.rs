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
    Refresh(Vec<CollectionSummary>, mpsc::SyncSender<()>),
    Rescan(Uuid, mpsc::SyncSender<()>),
}

struct WatchWorker {
    stop: mpsc::Sender<()>,
    rescan: mpsc::Sender<mpsc::SyncSender<()>>,
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
        let (ready, receiver) = mpsc::sync_channel(0);
        let command = WatchCommand::Refresh(
            collections
                .iter()
                .filter(|collection| collection.enabled)
                .cloned()
                .collect(),
            ready,
        );
        if let Err(error) = self.commands.send(command) {
            tracing::warn!(%error, "collection watcher is unavailable");
            return;
        }
        if let Err(error) = receiver.recv() {
            tracing::warn!(%error, "collection watcher did not acknowledge readiness");
        }
    }

    pub fn rescan(&self, collection_id: Uuid) {
        let (ready, receiver) = mpsc::sync_channel(0);
        if let Err(error) = self
            .commands
            .send(WatchCommand::Rescan(collection_id, ready))
        {
            tracing::warn!(%error, "collection watcher is unavailable");
            return;
        }
        if let Err(error) = receiver.recv() {
            tracing::warn!(%error, "collection watcher did not complete the requested rescan");
        }
    }
}

fn watch_supervisor(registry: CollectionRegistry, commands: mpsc::Receiver<WatchCommand>) {
    let mut workers: HashMap<Uuid, WatchWorker> = HashMap::new();
    while let Ok(command) = commands.recv() {
        match command {
            WatchCommand::Refresh(collections, ready) => {
                refresh_workers(&registry, &mut workers, collections);
                let _ = ready.send(());
            }
            WatchCommand::Rescan(collection_id, ready) => {
                if let Some(worker) = workers.get(&collection_id) {
                    if let Err(error) = worker.rescan.send(ready) {
                        let _ = error.0.send(());
                    }
                } else {
                    let _ = ready.send(());
                }
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
        if let std::collections::hash_map::Entry::Vacant(entry) = workers.entry(collection.id) {
            if let Some(worker) = start_worker(
                registry.clone(),
                collection.id,
                PathBuf::from(collection.path),
            ) {
                entry.insert(worker);
            }
        }
    }
}

fn start_worker(
    registry: CollectionRegistry,
    collection_id: Uuid,
    root: PathBuf,
) -> Option<WatchWorker> {
    let watcher = match CollectionWatcher::open(&root, Duration::from_millis(120)) {
        Ok(watcher) => watcher,
        Err(error) => {
            tracing::error!(collection_id = %collection_id, path = %root.display(), %error, "failed to watch collection");
            return None;
        }
    };
    let (stop, stop_rx) = mpsc::channel();
    let (rescan, rescan_rx) = mpsc::channel::<mpsc::SyncSender<()>>();
    let worker = thread::Builder::new()
        .name(format!("mdbase-connect-watch-{collection_id}"))
        .spawn(move || {
            loop {
                if stop_rx.try_recv().is_ok() {
                    return;
                }
                while let Ok(ready) = rescan_rx.try_recv() {
                    if let Err(error) = watcher.rescan() {
                        tracing::warn!(collection_id = %collection_id, %error, "collection rescan failed");
                    }
                    while let Ok(Some(event)) = watcher.recv_timeout(Duration::ZERO) {
                        persist_event(&registry, collection_id, &event);
                    }
                    let _ = ready.send(());
                }
                match watcher.recv_timeout(Duration::from_millis(100)) {
                    Ok(Some(event)) => persist_event(&registry, collection_id, &event),
                    Ok(None) => {}
                    Err(error) => {
                        tracing::warn!(collection_id = %collection_id, %error, "collection watcher stopped");
                        return;
                    }
                }
            }
        })
        .expect("failed to start collection watcher thread");
    Some(WatchWorker {
        stop,
        rescan,
        worker,
    })
}

fn persist_event(
    registry: &CollectionRegistry,
    collection_id: Uuid,
    event: &mdbase::watch::WatchEvent,
) {
    if let Err(error) = registry.append_change(collection_id, event) {
        tracing::warn!(collection_id = %collection_id, %error, "failed to persist collection change");
    } else {
        tracing::debug!(collection_id = %collection_id, event_type = %event.event_type, sequence = event.sequence, "collection change recorded");
    }
}

fn stop_worker(worker: WatchWorker) {
    let _ = worker.stop.send(());
    let _ = worker.worker.join();
}
