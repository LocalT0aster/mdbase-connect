# `@mdbase/connect`

Browser SDK for dynamically discovered MDBASE Connect applications.

```ts
const connect = new MdbaseConnect({
  serverUrl: "https://connect.mdbase.dev",
  manifestUrl: "https://workouts.example/.well-known/mdbase-app.json",
  redirectUri: "https://workouts.example/auth/mdbase/callback"
});

await connect.authorize(["read", "query"]);

// On the callback route:
await connect.completeAuthorization();
const workouts = await connect.query({ types: ["workout"] });
```

Application identity is derived from the manifest's exact origin. No developer
account or manually issued client secret is required.

