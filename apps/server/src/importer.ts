import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { SCHEMA_VERSION, newId, type Workflow } from '@nodepilot/shared';
import { isWithin, realpathLoose } from '@nodepilot/shared/node';
import { analyzeRepository, type AnalysisMode, type AnalysisResult, type SourceFile } from './analyze.js';
import { nowIso } from './db.js';
import type { Projects } from './projects.js';
import { HttpError, type WorkflowStore } from './workflows.js';

const exec = promisify(execFile);

export const DEMO_MARKER = '.nodepilot-demo-copy.txt';
export const MAX_FILE_BYTES = 400 * 1024;
export const MAX_FILES = 4000;

export const gitImportSchema = z.object({
  url: z.string().trim().min(1).max(500),
  name: z.string().trim().max(80).optional(),
  mode: z.enum(['auto', 'structure', 'pipeline']).default('auto'),
});

export const filesImportSchema = z.object({
  name: z.string().trim().min(1).max(80),
  files: z.array(z.object({ path: z.string().min(1).max(400), content: z.string().max(MAX_FILE_BYTES) })).min(1).max(MAX_FILES),
  mode: z.enum(['auto', 'structure', 'pipeline']).default('auto'),
});

const TEXT_EXT = /\.(ts|tsx|js|mjs|cjs|jsx|py|go|rs|java|kt|rb|php|cs|swift|md|txt|prompt|ya?ml|json|toml|j2|jinja|hbs|mustache|sql)$/i;
const WALK_SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', 'vendor', 'venv', '.venv', '__pycache__', '.next', 'target']);

export interface ImportResult { workflow: Workflow; projectId: string; stats: AnalysisResult['stats'] }

/** Builds an initial workflow from a git repository or an uploaded folder. */
export class Importer {
  constructor(private dataDir: string, private projects: Projects, private store: WorkflowStore) {}

  private dir(name: string) {
    const root = path.join(this.dataDir, 'imports');
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'project';
    const dir = path.join(root, `${slug}-${newId('i').slice(2, 8)}`);
    fs.mkdirSync(dir, { recursive: true });
    return { dir, slug };
  }

  async fromGit(input: z.infer<typeof gitImportSchema>): Promise<ImportResult> {
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      throw new HttpError(422, 'invalid_url', 'Enter an https:// git URL, e.g. https://github.com/owner/repo');
    }
    if (url.protocol !== 'https:' || url.username || url.password) throw new HttpError(422, 'invalid_url', 'Only public https:// git URLs without credentials are supported');
    const repoName = input.name || decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? 'repo').replace(/\.git$/, '');
    const { dir, slug } = this.dir(repoName);
    try {
      await exec('git', [
        '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'core.symlinks=false',
        'clone', '--depth', '1', '--single-branch', '--no-tags', '--', url.toString(), dir,
      ], { timeout: 180_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' }, windowsHide: true });
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      const msg = ((e as { stderr?: string }).stderr || (e as Error).message).trim().split('\n').slice(-2).join(' ');
      throw new HttpError(422, 'clone_failed', `git clone failed: ${msg.slice(0, 300)}`);
    }
    // The copy must never be able to reach the original: drop its remote so nothing can be fetched or pushed.
    try { await exec('git', ['-C', dir, 'remote', 'remove', 'origin'], { windowsHide: true }); } catch { /* already detached */ }
    return this.finish(repoName, slug, dir, readTree(dir), url.toString(), input.mode);
  }

  async fromFiles(input: z.infer<typeof filesImportSchema>): Promise<ImportResult> {
    const { dir, slug } = this.dir(input.name);
    // Strip the uploaded folder's own name so paths are repository-relative.
    const first = input.files[0].path.replace(/\\/g, '/').split('/')[0];
    const shared = input.files.every((f) => f.path.replace(/\\/g, '/').startsWith(`${first}/`));
    const files: SourceFile[] = [];
    for (const f of input.files) {
      let rel = f.path.replace(/\\/g, '/');
      if (shared) rel = rel.slice(first.length + 1);
      const target = path.resolve(dir, rel);
      if (!rel || rel.includes('\0') || !isWithin(dir, target) || target === dir) throw new HttpError(422, 'invalid_path', `Invalid file path: ${f.path}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, f.content);
      files.push({ path: rel, content: f.content });
    }
    return this.finish(input.name, slug, dir, files, 'uploaded folder', input.mode);
  }

  /**
   * Deletes the private demo copy behind an imported workflow and un-approves its project.
   * Only ever touches folders inside NodePilot's own imports directory; a project that points
   * anywhere else (a real folder you approved yourself) is left alone. Returns whether a copy was removed.
   */
  removeDemoCopy(projectId: string | undefined, stillUsed: boolean): boolean {
    if (!projectId || stillUsed) return false;
    let rootPath: string;
    try {
      rootPath = this.projects.get(projectId).rootPath;
    } catch {
      return false;
    }
    const importsRoot = realpathLoose(path.join(this.dataDir, 'imports'));
    const real = realpathLoose(rootPath);
    if (real === importsRoot || !isWithin(importsRoot, real)) return false;
    this.projects.remove(projectId);
    // maxRetries: git object files are read-only on Windows and virus scanners can briefly lock fresh files.
    fs.rmSync(real, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return true;
  }

  private finish(name: string, slug: string, dir: string, files: SourceFile[], source: string, mode: AnalysisMode = 'auto'): ImportResult {
    const analysis = analyzeRepository(files, { serviceId: slug.slice(0, 64) || 'project', projectName: name, mode });
    if (analysis.stats.filesScanned === 0) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new HttpError(422, 'no_sources', 'No source files were found to analyse');
    }
    // Marker so nobody mistakes this private copy for the real project.
    fs.writeFileSync(path.join(dir, DEMO_MARKER), `NodePilot demo copy.
Source: ${source}
Imported: ${nowIso()}

This is a private snapshot used only to draw the demo graph.
The original project was only read, never modified. Safe to delete.
`);
    const project = this.projects.add(dir, name);
    const now = nowIso();
    const doc: Workflow = {
      schemaVersion: SCHEMA_VERSION,
      id: newId('wf'),
      name: name.slice(0, 120),
      description: `DEMO COPY of ${source}, mapped as ${analysis.stats.mode === 'pipeline' ? 'an AI pipeline' : 'its code structure (entry points → modules → external services)'}: ${analysis.stats.reason}. Read ${analysis.stats.filesScanned} source files (${analysis.stats.languages.join(', ') || 'unknown languages'})${analysis.stats.hiddenModules ? `; ${analysis.stats.hiddenModules} smaller modules not shown` : ''}. The original project was only read and is never modified. Heuristic: review and edit.`,
      revision: 1,
      isExample: false,
      projectId: project.id,
      nodes: analysis.nodes,
      edges: analysis.edges,
      createdAt: now,
      updatedAt: now,
    };
    const workflow = this.store.importWorkflow(doc, 'ui');
    return { workflow, projectId: project.id, stats: analysis.stats };
  }
}

function readTree(root: string): SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= MAX_FILES) return;
      if (ent.isSymbolicLink()) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        // Dependencies, virtualenvs (any folder with "venv" in its name), site-packages and hidden folders hold no project code.
        if (!WALK_SKIP.has(ent.name) && !/venv|^site-packages$/i.test(ent.name) && !ent.name.startsWith('.')) walk(abs);
      } else if (ent.isFile() && TEXT_EXT.test(ent.name)) {
        const st = fs.statSync(abs);
        if (st.size <= MAX_FILE_BYTES) out.push({ path: path.relative(root, abs).replace(/\\/g, '/'), content: fs.readFileSync(abs, 'utf8') });
      }
    }
  };
  walk(root);
  return out;
}
