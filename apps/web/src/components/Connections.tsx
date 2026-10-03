import { useEffect, useState } from 'react';
import { api, enc } from '../api';
import { useStore } from '../store';
import { fmtAgo, StatusChip } from '../status';
import { Modal } from './Modal';

const TABS = [
  ['projects', 'Projects'],
  ['runner', 'Claude runner'],
  ['mcp', 'Claude Code MCP'],
  ['github', 'GitHub'],
  ['backends', 'Backends'],
  ['secrets', 'Secrets'],
] as const;

export function Connections() {
  const tab = useStore((s) => s.connectionsTab);
  const set = useStore((s) => s.set);
  return (
    <Modal title="Connections" onClose={() => set({ dialog: null })} wide>
      <div className="tabs" role="tablist">
        {TABS.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`tab${tab === k ? ' active' : ''}`} onClick={() => set({ connectionsTab: k })}>{l}</button>
        ))}
      </div>
      <div className="tab-body">
        {tab === 'projects' && <Projects />}
        {tab === 'runner' && <Runner />}
        {tab === 'mcp' && <Mcp />}
        {tab === 'github' && <GitHub />}
        {tab === 'backends' && <Backends />}
        {tab === 'secrets' && <Secrets />}
      </div>
    </Modal>
  );
}

const toastErr = (e: unknown) => useStore.getState().toast('error', (e as Error).message);

function useLive<T>(url: string, deps: unknown[] = [], busTypes: string[] = []): [T | undefined, () => void] {
  const [data, setData] = useState<T>();
  const load = () => void api.get<T>(url).then(setData).catch(toastErr);
  useEffect(load, [url, ...deps]);
  useEffect(() => {
    if (!busTypes.length) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);
  return [data, load];
}

function Projects() {
  const [projects, load] = useLive<{ id: string; name: string; rootPath: string }[]>('/api/projects');
  const [path, setPath] = useState('');
  return (
    <div className="form">
      <p className="muted">Approved project directories. NodePilot only reads or writes files inside these roots (traversal and symlink escapes are refused). They are used for code references, “Open in VS Code” links and workflow file sync.</p>
      <ul className="list">
        {projects?.map((p) => (
          <li key={p.id} className="row">
            <b>{p.name}</b> <span className="mono small">{p.rootPath}</span>
            <span className="grow" />
            <button className="btn ghost xs" onClick={() => void api.del(`/api/projects/${enc(p.id)}`).then(load)}>Remove</button>
          </li>
        ))}
        {projects?.length === 0 && <li className="muted">No approved projects.</li>}
      </ul>
      <div className="row">
        <input className="input mono grow" placeholder="Absolute path, e.g. D:\code\my-ai-app" value={path} onChange={(e) => setPath(e.target.value)} aria-label="Project path" />
        <button className="btn primary" disabled={!path.trim()} onClick={() => void api.post('/api/projects', { rootPath: path.trim() }).then(() => { setPath(''); load(); }).catch(toastErr)}>Approve directory</button>
      </div>
    </div>
  );
}

interface RunnerRow { id: string; name: string; online: boolean; lastSeenAt?: string; info: { projects: string[]; claude: { found: boolean; version?: string; error?: string; permissionModes?: string[] }; testCommand?: string; confirmMode: string; platform?: string } }
interface PairReq { id: string; code: string; name: string; createdAt: string; info: RunnerRow['info'] }

function Runner() {
  const [runners, loadR] = useLive<RunnerRow[]>('/api/runners', [], ['runner']);
  const [pending, loadP] = useLive<PairReq[]>('/api/runner/pair-requests', [], ['runner']);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const decide = (id: string, approve: boolean) =>
    void api.post(`/api/runner/pair-requests/${enc(id)}/decide`, { approve, code: codes[id] ?? '' }).then(() => { loadP(); loadR(); }).catch(toastErr);
  const repo = 'D:\\path\\to\\your-repo';
  return (
    <div className="form">
      <p className="muted">
        The runner is a small local process <b>you start explicitly</b>. It runs Claude Code in headless print mode (<span className="mono">claude -p --output-format stream-json</span>) inside an isolated git worktree,
        only for directories you approve when starting it. It keeps Claude Code's normal permission rules (no bypass flags; requests that would need a prompt are denied and reported), never pushes or merges,
        and never sends your Claude credentials to this app.
      </p>
      <h4>1. Start the runner</h4>
      <pre className="code">{`npm run build            # once\nnpm run runner -- --project "${repo}" --test-cmd "npm test"`}</pre>
      <p className="muted small">Options: <span className="mono">--confirm browser</span> (skip the terminal y/N prompt), <span className="mono">--allow-tool "Bash(npm test)"</span> (pre-approve a tool rule), <span className="mono">--claude-bin</span>. If Claude Code is missing, install it from the official docs and run <span className="mono">claude</span> once to sign in.</p>
      <h4>2. Approve the pairing request</h4>
      {pending?.length ? pending.map((p) => (
        <div className="card" key={p.id}>
          <div><b>{p.name}</b> wants to pair · {fmtAgo(p.createdAt)} · projects: <span className="mono small">{p.info.projects.join(', ')}</span></div>
          <div className="small">Claude Code: {p.info.claude.found ? p.info.claude.version : <span className="tone-fail">not found — {p.info.claude.error}</span>}</div>
          <div className="row">
            <input className="input mono" placeholder="Code shown in the runner terminal" value={codes[p.id] ?? ''} onChange={(e) => setCodes({ ...codes, [p.id]: e.target.value })} aria-label="Pairing code" />
            <button className="btn primary" onClick={() => decide(p.id, true)}>Approve</button>
            <button className="btn ghost" onClick={() => decide(p.id, false)}>Deny</button>
          </div>
        </div>
      )) : <p className="muted small">No pending requests.</p>}
      <h4>Paired runners</h4>
      {runners?.length ? runners.map((r) => (
        <div className="card" key={r.id}>
          <div className="row">
            <StatusChip status={r.online ? 'ok' : 'stale'} title={r.online ? 'Connected' : 'Disconnected'} /> <b>{r.name}</b> <span className="muted small">{r.online ? 'connected' : `disconnected · last seen ${fmtAgo(r.lastSeenAt)}`}</span>
            <span className="grow" />
            <button className="btn ghost xs" onClick={() => void api.del(`/api/runners/${enc(r.id)}`).then(loadR)}>Revoke</button>
          </div>
          <div className="small">Claude Code: {r.info.claude.found ? <span className="mono">{r.info.claude.version}</span> : <span className="tone-fail">{r.info.claude.error}</span>} · confirm in {r.info.confirmMode} · tests: <span className="mono">{r.info.testCommand ?? 'none'}</span></div>
          <div className="small mono">{r.info.projects.join('  ·  ')}</div>
        </div>
      )) : <p className="muted small">None yet.</p>}
    </div>
  );
}

function Mcp() {
  const [info] = useLive<{ command: string; args: string[]; env: Record<string, string>; built: boolean; cli: string }>('/api/settings/mcp');
  if (!info) return null;
  const json = JSON.stringify({ mcpServers: { nodepilot: { type: 'stdio', command: info.command, args: info.args, env: info.env } } }, null, 2);
  return (
    <div className="form">
      <p className="muted">Lets Claude Code list, inspect, validate and patch workflows. Every change goes through the same validation, revision checks and audit log as the UI, and appears live on this canvas.</p>
      {!info.built && <div className="banner warn">Build first: <span className="mono">npm run build</span></div>}
      <h4>Add with the Claude Code CLI</h4>
      <pre className="code">{info.cli}</pre>
      <button className="btn ghost small" onClick={() => void navigator.clipboard?.writeText(info.cli)}>Copy command</button>
      <h4>…or add to a project's <span className="mono">.mcp.json</span></h4>
      <pre className="code">{json}</pre>
      <p className="muted small">The MCP server reads its access token from <span className="mono">{info.env.NODEPILOT_DATA_DIR}\mcp-token</span> (created by this server, readable by your OS user). Verify with <span className="mono">claude mcp list</span>, then ask Claude e.g. “Use nodepilot to list workflows and add a note to the scanner node.” Tools: list_workflows, get_workflow, inspect_node, validate_workflow, propose_workflow_patch, apply_workflow_patch, add_node_note, inspect_run.</p>
    </div>
  );
}

interface GhStatus {
  state: string; missing?: string[]; message?: string; at?: string;
  repo: { owner: string; repo: string; branch: string } | null;
  webhook: { secretConfigured: boolean; lastDelivery: { at: string; event: string; associated: boolean } | null; note: string };
  cache: null | {
    fetchedAt: string; repository: { fullName: string; defaultBranch: string; url: string; private: boolean }; branch: string;
    commits: { sha: string; url: string; message: string; author?: string; date?: string }[];
    pulls: { number: number; title: string; url: string; author?: string; branch: string; draft: boolean }[];
    checks: { name: string; status: string; conclusion: string | null; url: string }[];
    workflowRuns: { id: number; name: string; status: string; conclusion: string | null; url: string; createdAt: string }[];
  };
}

function GitHub() {
  const [s, load] = useLive<GhStatus>('/api/github/status', [], ['github']);
  const [form, setForm] = useState({ owner: '', repo: '', branch: 'main' });
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (s?.repo) setForm(s.repo); }, [s?.repo?.owner, s?.repo?.repo, s?.repo?.branch]);
  if (!s) return null;
  const c = s.cache;
  const concl = (x: { status: string; conclusion: string | null }) => (x.status !== 'completed' ? 'running' : x.conclusion === 'success' ? 'succeeded' : x.conclusion === 'skipped' || x.conclusion === 'neutral' ? 'skipped' : x.conclusion === 'cancelled' ? 'cancelled' : 'failed');
  return (
    <div className="form">
      <div className="row">
        <StatusChip status={s.state === 'connected' ? 'ok' : s.state === 'error' ? 'failing' : 'unknown'} />
        <b>{s.state === 'not_configured' ? 'Not connected' : s.state === 'no_repository' ? 'No repository selected' : s.state === 'error' ? 'Error' : 'Connected'}</b>
        {s.message && <span className="tone-fail small">{s.message}</span>}
      </div>
      {s.state === 'not_configured' && (
        <div className="banner info">
          GitHub App credentials are not configured. Set {s.missing?.join(', ')} in <span className="mono">.env</span> and restart the server. See <span className="mono">docs/GITHUB.md</span>.
          The app requests read-only access (contents, metadata, pull requests, checks, actions) and installation tokens never reach the browser.
        </div>
      )}
      <div className="row">
        <input className="input" placeholder="owner" value={form.owner} onChange={(e) => setForm({ ...form, owner: e.target.value })} aria-label="Owner" />
        <span>/</span>
        <input className="input" placeholder="repository" value={form.repo} onChange={(e) => setForm({ ...form, repo: e.target.value })} aria-label="Repository" />
        <input className="input" placeholder="branch" value={form.branch} onChange={(e) => setForm({ ...form, branch: e.target.value })} aria-label="Branch" />
        <button className="btn" onClick={() => void api.put('/api/github/repo', form).then(load).catch(toastErr)}>Select</button>
        <button className="btn primary" disabled={busy || s.state === 'not_configured' || !s.repo} onClick={() => { setBusy(true); void api.post('/api/github/refresh').then(load).catch(toastErr).finally(() => setBusy(false)); }}>{busy ? 'Refreshing…' : '↻ Refresh'}</button>
      </div>
      <p className="muted small">Webhook: secret {s.webhook.secretConfigured ? 'configured' : 'not configured'} · last delivery {s.webhook.lastDelivery ? `${s.webhook.lastDelivery.event} ${fmtAgo(s.webhook.lastDelivery.at)}${s.webhook.lastDelivery.associated ? '' : ' (other repo)'}` : 'never'}. {s.webhook.note}</p>
      {c && (
        <div className="gh-grid">
          <div>
            <h4><a href={c.repository.url} target="_blank" rel="noreferrer">{c.repository.fullName}</a> @ {c.branch}</h4>
            <p className="muted small">Fetched {fmtAgo(c.fetchedAt)}</p>
            <h4>Recent commits</h4>
            <ul className="list">{c.commits.map((x) => <li key={x.sha}><a className="mono small" href={x.url} target="_blank" rel="noreferrer">{x.sha.slice(0, 7)}</a> {x.message} <span className="muted small">{x.author} · {fmtAgo(x.date)}</span></li>)}</ul>
          </div>
          <div>
            <h4>Open pull requests</h4>
            <ul className="list">{c.pulls.length ? c.pulls.map((p) => <li key={p.number}><a href={p.url} target="_blank" rel="noreferrer">#{p.number}</a> {p.title} {p.draft && <span className="badge">draft</span>} <span className="muted small">{p.author} · {p.branch}</span></li>) : <li className="muted">None</li>}</ul>
            <h4>Checks on head</h4>
            <ul className="list">{c.checks.length ? c.checks.map((x, i) => <li key={i}><StatusChip status={concl(x)} small /> <a href={x.url} target="_blank" rel="noreferrer">{x.name}</a></li>) : <li className="muted">None</li>}</ul>
            <h4>Workflow runs</h4>
            <ul className="list">{c.workflowRuns.length ? c.workflowRuns.map((x) => <li key={x.id}><StatusChip status={concl(x)} small /> <a href={x.url} target="_blank" rel="noreferrer">{x.name}</a> <span className="muted small">{fmtAgo(x.createdAt)}</span></li>) : <li className="muted">None</li>}</ul>
          </div>
        </div>
      )}
    </div>
  );
}

interface Service {
  id: string; name: string; lastEventAt?: string; duplicateCount: number;
  indicators: Record<'reachable' | 'execution' | 'evaluation' | 'telemetry', { state: string; detail: string }>;
}
interface Target { id: string; name: string; url: string; serviceId?: string; lastOk?: boolean; lastStatus?: number; lastError?: string; lastLatencyMs?: number; lastCheckedAt?: string }

function Backends() {
  const [services, loadS] = useLive<Service[]>('/api/services', [], ['telemetry']);
  const [targets, loadT] = useLive<Target[]>('/api/health-targets', [], ['health']);
  const [svc, setSvc] = useState({ name: 'Example backend', id: 'example-backend' });
  const [tgt, setTgt] = useState({ name: 'example /health', url: 'http://127.0.0.1:4400/health', serviceId: 'example-backend' });
  const [token, setToken] = useState<string | null>(null);
  const IND: [keyof Service['indicators'], string][] = [['reachable', 'Service reachable'], ['execution', 'Workflow executing'], ['evaluation', 'Functional evaluation'], ['telemetry', 'Telemetry freshness']];
  return (
    <div className="form">
      <p className="muted">Two separate inputs: <b>health endpoints</b> (is the service up?) and <b>authenticated execution events</b> from your instrumented backend (did nodes run, did evaluations pass?). An HTTP 200 does not prove output quality, and stale telemetry never changes recorded run results.</p>
      {services?.map((s) => (
        <div className="card" key={s.id}>
          <div className="row"><b>{s.name}</b> <span className="mono small">{s.id}</span> <span className="muted small">last event {fmtAgo(s.lastEventAt)} · {s.duplicateCount} duplicate(s) ignored</span>
            <span className="grow" />
            <button className="btn ghost xs" onClick={() => void api.post<{ ingestToken: string }>(`/api/services/${enc(s.id)}/rotate`).then((r) => setToken(r.ingestToken))}>Rotate token</button>
            <button className="btn ghost xs" onClick={() => { if (confirm('Delete service and its telemetry?')) void api.del(`/api/services/${enc(s.id)}`).then(loadS); }}>Delete</button>
          </div>
          <div className="indicators">
            {IND.map(([k, label]) => (
              <div key={k} className="indicator"><div className="small muted">{label}</div><StatusChip status={s.indicators[k].state} title={s.indicators[k].detail} /><div className="small">{s.indicators[k].detail}</div></div>
            ))}
          </div>
        </div>
      ))}
      {token && <div className="banner warn">New ingest token (shown once): <span className="mono sel-all">{token}</span><br />Use it as <span className="mono">NODEPILOT_INGEST_TOKEN</span> for your backend. <button className="btn ghost xs" onClick={() => setToken(null)}>Hide</button></div>}
      <h4>Add backend service</h4>
      <div className="row">
        <input className="input" value={svc.name} onChange={(e) => setSvc({ ...svc, name: e.target.value })} aria-label="Service name" />
        <input className="input mono" value={svc.id} onChange={(e) => setSvc({ ...svc, id: e.target.value })} aria-label="Service id" />
        <button className="btn primary" onClick={() => void api.post<{ ingestToken: string }>('/api/services', svc).then((r) => { setToken(r.ingestToken); loadS(); }).catch(toastErr)}>Create & get token</button>
      </div>
      <h4>Health endpoints (explicitly approved targets)</h4>
      <ul className="list">
        {targets?.map((t) => (
          <li key={t.id} className="row">
            <StatusChip status={t.lastOk === undefined ? 'unknown' : t.lastOk ? 'ok' : 'failing'} small />
            <b>{t.name}</b> <span className="mono small">{t.url}</span> <span className="muted small">{t.serviceId ?? ''} · {t.lastStatus ? `HTTP ${t.lastStatus}` : t.lastError ?? ''} {t.lastLatencyMs !== undefined ? `· ${t.lastLatencyMs} ms` : ''} · {fmtAgo(t.lastCheckedAt)}</span>
            <span className="grow" />
            <button className="btn ghost xs" onClick={() => void api.post(`/api/health-targets/${enc(t.id)}/check`).then(loadT)}>Check now</button>
            <button className="btn ghost xs" onClick={() => void api.del(`/api/health-targets/${enc(t.id)}`).then(loadT)}>Remove</button>
          </li>
        ))}
      </ul>
      <div className="row">
        <input className="input" value={tgt.name} onChange={(e) => setTgt({ ...tgt, name: e.target.value })} aria-label="Target name" />
        <input className="input mono grow" value={tgt.url} onChange={(e) => setTgt({ ...tgt, url: e.target.value })} aria-label="Target URL" />
        <input className="input mono" value={tgt.serviceId} onChange={(e) => setTgt({ ...tgt, serviceId: e.target.value })} aria-label="Service id" placeholder="service id" />
        <button className="btn" onClick={() => void api.post('/api/health-targets', { ...tgt, serviceId: tgt.serviceId || undefined }).then(loadT).catch(toastErr)}>Approve & add</button>
      </div>
      <p className="muted small">Only status code and latency are recorded (never the body). Cloud metadata addresses are blocked, and redirects are followed only within the approved origin.</p>
    </div>
  );
}

function Secrets() {
  const [list, load] = useLive<{ name: string; createdAt: string }[]>('/api/secrets');
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  return (
    <div className="form">
      <p className="muted">Write-only local secret store (inside the git-ignored data directory). Values are never shown again or sent to the browser, and are redacted from logs, events, exports and diffs. Reference them from model nodes as <span className="mono">secret:name</span>, or use environment variables via <span className="mono">env:NAME</span>.</p>
      <ul className="list">{list?.map((s) => <li key={s.name} className="row"><span className="mono">secret:{s.name}</span> <span className="muted small">{fmtAgo(s.createdAt)}</span><span className="grow" /><button className="btn ghost xs" onClick={() => void api.del(`/api/secrets/${enc(s.name)}`).then(load)}>Delete</button></li>)}</ul>
      <div className="row">
        <input className="input mono" placeholder="name (e.g. anthropic-main)" value={name} onChange={(e) => setName(e.target.value)} aria-label="Secret name" />
        <input className="input mono grow" type="password" autoComplete="off" placeholder="value" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Secret value" />
        <button className="btn primary" disabled={!name || !value} onClick={() => void api.put(`/api/secrets/${enc(name)}`, { value }).then(() => { setName(''); setValue(''); load(); }).catch(toastErr)}>Store</button>
      </div>
    </div>
  );
}
