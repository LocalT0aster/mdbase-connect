import "@fontsource-variable/archivo";
import "@fontsource/ibm-plex-mono/400.css";
import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, ApiError, type DashboardData } from "./api";
import "./styles.css";

function Portal() {
  const pairingId = location.pathname.match(/^\/pair\/([0-9a-f-]+)$/i)?.[1];
  const authorizationId = location.pathname.match(/^\/authorize\/([0-9a-f-]+)$/i)?.[1];
  if (location.pathname === "/login") return <Login />;
  if (pairingId) return <Pairing pairingId={pairingId} />;
  if (authorizationId) return <Authorization requestId={authorizationId} />;
  return <Dashboard />;
}

function Login() {
  const [name, setName] = useState("Callum");
  const [email, setEmail] = useState("callum@example.com");
  const [error, setError] = useState("");

  async function signIn(event: React.FormEvent) {
    event.preventDefault();
    try {
      await api("/v1/dev/session", { method: "POST", body: JSON.stringify({ name, email }) });
      const requested = new URLSearchParams(location.search).get("return_to");
      if (requested) {
        const target = new URL(requested, location.origin);
        location.href = target.origin === location.origin ? target.href : "/";
      } else location.href = "/";
    } catch (signInError) {
      setError(message(signInError));
    }
  }

  return (
    <main className="center-page">
      <div className="page-brand"><Brand /><span>Connect</span></div>
      <form className="auth-panel" onSubmit={(event) => void signIn(event)}>
        <p className="eyebrow">Local development</p>
        <h1>Open your account</h1>
        <p>This temporary sign-in is available only when development authentication is enabled.</p>
        {error && <div className="message error">{error}</div>}
        <label><span>Name</span><input value={name} onChange={(event) => setName(event.target.value)} /></label>
        <label><span>Email</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <button className="button primary" type="submit">Continue</button>
      </form>
    </main>
  );
}

function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState("");

  async function refresh() {
    try {
      setData(await api<DashboardData>("/v1/me"));
      setError("");
    } catch (refreshError) {
      if (refreshError instanceof ApiError && refreshError.status === 401) {
        location.href = `/login?return_to=${encodeURIComponent(location.href)}`;
      } else setError(message(refreshError));
    }
  }

  useEffect(() => { void refresh(); }, []);
  if (!data) return <Loading error={error} />;

  return (
    <div className="account-shell">
      <aside className="account-nav">
        <div className="nav-brand"><Brand /><span>Connect</span></div>
        <nav><a className="active" href="#computers">Computers</a><a href="#account">Account</a></nav>
        <div className="signed-in"><span>{initials(data.user.name)}</span><div><strong>{data.user.name}</strong><small>{data.user.email}</small></div></div>
      </aside>
      <main className="account-main">
        <header><p className="eyebrow">Your account</p><h1>Computers and recovery.</h1><p>Collections and application permissions are managed on the computer that holds them.</p></header>
        {error && <div className="message error">{error}</div>}
        <section id="computers">
          <SectionHeading title="Connected computers" note="Revoking a computer immediately invalidates all of its application access." count={data.connectors.length} />
          {data.connectors.length === 0 ? <Empty title="No computers connected" text="Open MDBASE Connect on a computer and choose Connect this computer." /> : (
            <div className="computer-list">{data.connectors.map((connector) => {
              const count = data.collections.filter((collection) => collection.connector_id === connector.id).length;
              return <div className="computer-row" key={connector.id}><span className="computer-icon" aria-hidden="true" /><div><strong>{connector.name}</strong><small>{count} {count === 1 ? "collection" : "collections"} · {connector.last_seen_at ? `Seen ${relativeTime(connector.last_seen_at)}` : "Not connected yet"}</small></div><span className={`availability ${connector.last_seen_at ? "online" : "idle"}`}><i />{connector.last_seen_at ? "Registered" : "Pending"}</span><button className="quiet-danger" onClick={() => { if (window.confirm(`Revoke ${connector.name}? Applications connected through it will stop working.`)) void api(`/v1/connectors/${connector.id}`, { method: "DELETE" }).then(refresh).catch((reason) => setError(message(reason))); }}>Revoke</button></div>;
            })}</div>
          )}
        </section>
        <section id="account">
          <SectionHeading title="Account" note="Identity, recovery, and service administration." />
          <div className="account-rows"><AccountRow label="Name" value={data.user.name} /><AccountRow label="Email" value={data.user.email} mono /><AccountRow label="Plan" value="Development preview" detail="Billing is not enabled" /></div>
          <button className="button secondary" onClick={() => void api("/v1/logout", { method: "POST" }).then(() => { location.href = "/login"; })}>Sign out</button>
        </section>
      </main>
    </div>
  );
}

function Pairing({ pairingId }: { pairingId: string }) {
  const [pairing, setPairing] = useState<{ connector_name: string; approved_at: string | null } | null>(null);
  const [deepLink, setDeepLink] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ pairing: { connector_name: string; approved_at: string | null } }>(`/v1/pairing-requests/${pairingId}`)
      .then((value) => setPairing(value.pairing))
      .catch((reason) => {
        if (reason instanceof ApiError && reason.status === 401) location.href = `/login?return_to=${encodeURIComponent(location.href)}`;
        else setError(message(reason));
      });
  }, [pairingId]);

  async function approve() {
    try {
      const result = await api<{ deep_link: string }>(`/v1/pairing-requests/${pairingId}/approve`, { method: "POST" });
      setDeepLink(result.deep_link);
    } catch (approveError) { setError(message(approveError)); }
  }

  if (!pairing) return <Loading error={error} />;
  return (
    <main className="center-page">
      <div className="page-brand"><Brand /><span>Computer pairing</span></div>
      <section className="decision-panel">
        {deepLink ? <><p className="eyebrow">Computer approved</p><h1>Return to MDBASE Connect.</h1><p>The desktop app will finish securely. No connector token was displayed or copied.</p><a className="button primary link-button" href={deepLink}>Open MDBASE Connect</a></> : <><p className="eyebrow">New computer</p><h1>{pairing.connector_name}</h1><p>Allow this computer to connect to your account. It will publish collection names and route application requests, but not local folder paths.</p>{error && <div className="message error">{error}</div>}<div className="decision-actions"><a className="button secondary link-button" href="/">Cancel</a><button className="button primary" onClick={() => void approve()}>Approve computer</button></div></>}
      </section>
    </main>
  );
}

function Authorization({ requestId }: { requestId: string }) {
  const [request, setRequest] = useState<any>(null);
  const [status, setStatus] = useState<"pending" | "approved" | "denied">("pending");
  const [error, setError] = useState("");
  const deepLink = useMemo(() => `mdbase-connect://authorize?server=${encodeURIComponent(location.origin)}&request=${requestId}`, [requestId]);

  useEffect(() => {
    api<any>(`/v1/authorization-requests/${requestId}`)
      .then(setRequest)
      .catch((reason) => {
        if (reason instanceof ApiError && reason.status === 401) location.href = `/login?return_to=${encodeURIComponent(location.href)}`;
        else setError(message(reason));
      });
  }, [requestId]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void api<{ status: "pending" | "approved" | "denied" }>(`/v1/authorization-requests/${requestId}/status`).then((value) => setStatus(value.status)).catch(() => undefined);
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [requestId]);

  if (!request) return <Loading error={error} />;
  const authorization = request.authorization;
  return (
    <main className="center-page">
      <div className="page-brand"><Brand /><span>Application request</span></div>
      <section className="decision-panel authorization-panel">
        <div className="app-identity"><span>{initials(authorization.application_name)}</span><div><p className="eyebrow">Application access</p><h1>{authorization.application_name}</h1><code>{host(authorization.homepage)}</code></div></div>
        {status === "pending" ? <><p>Choose a collection and permissions in MDBASE Connect on one of your online computers.</p><div className="requested-scopes">{authorization.requested_operations.map((operation: string) => <code key={operation}>{operation}</code>)}</div>{error && <div className="message error">{error}</div>}<a className="button primary link-button" href={deepLink}>Open MDBASE Connect</a><small className="waiting-copy">Waiting for a local decision…</small></> : status === "approved" ? <><p className="eyebrow">Approved locally</p><h2>Continue in the application.</h2><p>MDBASE Connect opened the application callback in your browser. This tab can be closed.</p></> : <><p className="eyebrow">Denied locally</p><h2>Access was not granted.</h2><p>You can close this tab or return to the application.</p></>}
      </section>
    </main>
  );
}

function AccountRow({ label, value, detail, mono = false }: { label: string; value: string; detail?: string; mono?: boolean }) { return <div className="account-row"><span>{label}</span><div><strong className={mono ? "mono" : ""}>{value}</strong>{detail && <small>{detail}</small>}</div></div>; }
function Brand() { return <div className="brand"><span /><strong>MDBASE</strong></div>; }
function SectionHeading({ title, note, count }: { title: string; note: string; count?: number }) { return <div className="section-heading"><div><h2>{title}</h2><p>{note}</p></div>{count !== undefined && <span>{count}</span>}</div>; }
function Empty({ title, text }: { title: string; text: string }) { return <div className="empty"><span className="empty-folder" /><strong>{title}</strong><p>{text}</p></div>; }
function Loading({ error = "" }: { error?: string }) { return <main className="loading"><Brand /><p>{error || "Opening MDBASE Connect…"}</p></main>; }
function initials(value: string) { return value.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase(); }
function message(value: unknown) { return value instanceof Error ? value.message : String(value); }
function host(value: string) { try { return new URL(value).host; } catch { return value; } }
function relativeTime(value: string) {
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1_000);
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return format.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return format.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return format.format(hours, "hour");
  return format.format(Math.round(hours / 24), "day");
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><Portal /></React.StrictMode>);
