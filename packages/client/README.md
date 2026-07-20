# `@mdbase/connect`

Browser SDK for dynamically discovered MDBASE Connect applications.

```ts
const connect = new MdbaseConnect({
  serverUrl: "https://connect.mdbase.dev",
  manifestUrl: "https://workouts.example/.well-known/mdbase-app.json",
  redirectUri: "https://workouts.example/auth/mdbase/callback"
});

await connect.authorize(["describe", "changes", "read", "query", "update"]);

// On the callback route:
await connect.completeAuthorization();
const description = await connect.describe();
const workouts = await connect.query({ types: ["workout"] });

for await (const change of connect.watch()) {
  console.log(change.type, change.payload.path);
}
```

Application identity is derived from the manifest's exact origin. No developer
account or manually issued client secret is required.

The SDK returns the MDBASE operation envelope, carries revision tokens in typed
record results, and accepts `if_revision` on mutations. `describe()` exposes
JSON Schemas and optional domain contracts. `watch()` resumes from a local
collection cursor; the Connect server does not store the change feed.
