use mdbase_connect_protocol::CollectionSummary;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

#[derive(Clone)]
pub struct CollectionWatchService {
    commands: mpsc::Sender<WatchCommand>,
}

enum WatchCommand {
    Refresh(Vec<PathBuf>),
}

impl CollectionWatchService {
    pub fn start() -> Self {
        let (commands, receiver) = mpsc::channel();
        thread::Builder::new()
            .name("mdbase-connect-watch".to_string())
            .spawn(move || watch_loop(receiver))
            .expect("failed to start collection watcher thread");
        Self { commands }
    }

    pub fn refresh(&self, collections: &[CollectionSummary]) {
        let paths = collections
            .iter()
            .filter(|collection| collection.enabled)
            .map(|collection| PathBuf::from(&collection.path))
            .collect();
        if let Err(error) = self.commands.send(WatchCommand::Refresh(paths)) {
            tracing::warn!(%error, "collection watcher is unavailable");
        }
    }
}

fn watch_loop(commands: mpsc::Receiver<WatchCommand>) {
    let (events, event_receiver) = mpsc::channel();
    let mut watcher = match notify::recommended_watcher(move |event| {
        let _ = events.send(event);
    }) {
        Ok(watcher) => watcher,
        Err(error) => {
            tracing::error!(%error, "failed to initialize filesystem watcher");
            return;
        }
    };
    let mut watched = HashSet::new();

    loop {
        match commands.recv_timeout(Duration::from_millis(250)) {
            Ok(WatchCommand::Refresh(paths)) => refresh_paths(&mut watcher, &mut watched, paths),
            Err(mpsc::RecvTimeoutError::Disconnected) => return,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }

        while let Ok(event) = event_receiver.try_recv() {
            match event {
                Ok(event) => {
                    tracing::debug!(kind = ?event.kind, paths = ?event.paths, "collection filesystem event")
                }
                Err(error) => tracing::warn!(%error, "collection filesystem watch error"),
            }
        }
    }
}

fn refresh_paths(
    watcher: &mut RecommendedWatcher,
    watched: &mut HashSet<PathBuf>,
    requested: Vec<PathBuf>,
) {
    let requested: HashSet<_> = requested.into_iter().collect();
    for removed in watched.difference(&requested).cloned().collect::<Vec<_>>() {
        if let Err(error) = watcher.unwatch(&removed) {
            tracing::warn!(path = %removed.display(), %error, "failed to stop watching collection");
        }
    }
    for added in requested.difference(watched) {
        if let Err(error) = watcher.watch(added, RecursiveMode::Recursive) {
            tracing::warn!(path = %added.display(), %error, "failed to watch collection");
        }
    }
    *watched = requested;
}
