# MVP acceptance path

The MVP is complete when a user can:

1. Install MDBASE Connect and launch it automatically at login.
2. Create a v0.3 collection or register an existing one.
3. Pair the connector through a signed-in browser without copying a token.
4. Open an unrelated website that publishes an MDBASE app manifest.
5. See the pending request in the local controller, choose a collection, and
   approve exact operations there.
6. Query the local collection through the relay.
7. Pause remote access locally and observe requests fail without removing the
   grant.
8. Resume, revoke access locally, and observe the next request fail.
9. Review allowed and denied requests in the local activity log.
10. Close the desktop window while the tray connector continues running.

Not in the MVP: hosted collections, file synchronization, an Obsidian client,
a developer portal, an app marketplace, collection editing UI, multi-user
sharing, billing, or fine-grained field permissions.
