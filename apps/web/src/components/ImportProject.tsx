import { useRef, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { Modal } from './Modal';

const MAX_FILE_BYTES = 400 * 1024;
const MAX_FILES = 4000;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', 'vendor', 'venv', '.venv', '__pycache__', '.next', 'target', '.cache', '.turbo']);
const TEXT_EXT = /\.(ts|tsx|js|mjs|cjs|jsx|py|go|rs|java|kt|rb|php|cs|swift|md|txt|prompt|ya?ml|json|toml|j2|jinja|hbs|mustache|sql)$/i;
const SOURCE_EXT = /\.(ts|tsx|js|mjs|cjs|jsx|py|go|rs|java|kt|rb|php|cs|swift)$/i;
const PROMPTISH = /prompt|rules?|polic|instruction|system|persona|template/i;

interface Stats { filesScanned: number; filesMatched: number; models: string[]; languages: string[] }
interface ImportResponse { workflow: { id: string; name: string; nodes: unknown[] }; stats: Stats }

/** Import a project from a git link or an uploaded folder; the server reads it and builds the initial node graph. */
export function ImportProject() {
  const s = useStore();
  const [tab, setTab] = useState<'git' | 'folder'>('git');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<{ name: string; files: File[]; skipped: number } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const done = async (r: ImportResponse) => {
    await s.loadWorkflows();
    await s.loadWorkflow(r.workflow.id);
    s.set({ dialog: null });
    s.toast('success', `Imported “${r.workflow.name}”: ${r.workflow.nodes.length} nodes from ${r.stats.filesScanned} files${r.stats.models.length ? `, ${r.stats.models.length} model ids found` : ''}.`);
  };

  const importGit = async () => {
    setError(null);
    setBusy('Cloning and reading the repository…');
    try {
      await done(await api.post<ImportResponse>('/api/import/git', { url: url.trim() }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const onPick = (list: FileList | null) => {
    if (!list?.length) return;
    const all = [...list];
    const name = (all[0].webkitRelativePath || all[0].name).split('/')[0] || 'project';
    // Keep source code first when the folder has more files than the limit; data files (json, yaml, sql…) go last.
    const rank = (f: File) => (SOURCE_EXT.test(f.name) ? 0 : PROMPTISH.test(f.webkitRelativePath || f.name) ? 1 : 2);
    const files = all.filter((f) => {
      const parts = (f.webkitRelativePath || f.name).split('/');
      return !parts.slice(0, -1).some((p) => SKIP_DIRS.has(p)) && TEXT_EXT.test(f.name) && f.size <= MAX_FILE_BYTES;
    }).sort((a, b) => rank(a) - rank(b)).slice(0, MAX_FILES);
    setPicked({ name, files, skipped: all.length - files.length });
    setError(null);
  };

  const importFolder = async () => {
    if (!picked) return;
    setError(null);
    try {
      const out: { path: string; content: string }[] = [];
      for (let i = 0; i < picked.files.length; i++) {
        if (i % 50 === 0) setBusy(`Reading files… ${i}/${picked.files.length}`);
        const f = picked.files[i];
        out.push({ path: f.webkitRelativePath || f.name, content: await f.text() });
      }
      setBusy('Analysing the project…');
      await done(await api.post<ImportResponse>('/api/import/files', { name: picked.name, files: out }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal title="Import project" onClose={() => !busy && s.set({ dialog: null })}>
      <p className="muted small" style={{ margin: 0 }}>
        The project’s source files are read locally and grouped into pipeline stages: rules, routing, planning, discovery, screening, inspection, judging and ranking.
        Model ids found in the code are shown on the nodes. The result is a starting point to edit, not a guarantee.
      </p>
      <div className="seg" role="tablist" aria-label="Import source">
        <button role="tab" aria-selected={tab === 'git'} className={`seg-btn${tab === 'git' ? ' on' : ''}`} onClick={() => setTab('git')}>Git link</button>
        <button role="tab" aria-selected={tab === 'folder'} className={`seg-btn${tab === 'folder' ? ' on' : ''}`} onClick={() => setTab('folder')}>Upload folder</button>
      </div>

      {tab === 'git' && (
        <div className="form">
          <label className="field">
            <span className="field-label">Repository URL</span>
            <input
              className="input"
              placeholder="https://github.com/owner/repo"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && url.trim() && !busy && void importGit()}
              disabled={!!busy}
            />
            <span className="field-help">Public https repositories. A shallow clone is kept in the local data folder so code references open in your editor.</span>
          </label>
          <div className="row"><span className="grow" /><button className="btn primary" disabled={!url.trim() || !!busy} onClick={() => void importGit()}>Import</button></div>
        </div>
      )}

      {tab === 'folder' && (
        <div className="form">
          <input
            ref={fileInput}
            type="file"
            hidden
            multiple
            // Non-standard but supported by Chromium, Firefox and Safari.
            {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
            onChange={(e) => onPick(e.target.files)}
          />
          <button className="dropzone" onClick={() => fileInput.current?.click()} disabled={!!busy}>
            {picked ? (
              <>
                <b>{picked.name}</b>
                <span className="muted small">{picked.files.length} source files selected · {picked.skipped} skipped (dependencies, build output, binaries, files over 400 KB)</span>
              </>
            ) : (
              <>
                <b>Choose a project folder</b>
                <span className="muted small">node_modules, .git, build output and binaries are skipped automatically</span>
              </>
            )}
          </button>
          <div className="row"><span className="grow" /><button className="btn primary" disabled={!picked?.files.length || !!busy} onClick={() => void importFolder()}>Import</button></div>
        </div>
      )}

      {busy && <div className="banner info" role="status"><span className="spinner" aria-hidden="true" /> {busy}</div>}
      {error && <div className="banner fail" role="alert">{error}</div>}
    </Modal>
  );
}
