import { useEffect } from 'react';
import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
import { useStore } from './store';
import { connectLive } from './sse';
import { Toolbar } from './components/Toolbar';
import { Canvas } from './components/Canvas';
import { Inspector } from './inspector/Inspector';
import { Timeline } from './components/Timeline';
import { Connections } from './components/Connections';
import { AskClaude, TaskDetail } from './components/AskClaude';
import { ConflictBanner, DeleteWorkflowDialog, HelpDialog, NewWorkflow, PairingScreen, Toasts, ValidateDialog } from './components/Dialogs';
import { FloatingPanel } from './components/FloatingPanel';
import { RightDock } from './components/RightDock';
import { SimReviewDialog, SimulationOverlay } from './components/Simulation';
import { ImportProject } from './components/ImportProject';
import { NodeSearch } from './components/NodeSearch';
import { draftState } from './inspector/draft';

export function App() {
  const paired = useStore((s) => s.paired);
  useEffect(() => {
    void useStore.getState().init().catch((e) => useStore.getState().toast('error', `Cannot reach the server: ${(e as Error).message}`));
  }, []);
  useEffect(() => {
    if (paired) return connectLive();
  }, [paired]);

  if (paired === null) return <div className="loading">Connecting to the local server…</div>;
  if (!paired) return (<><PairingScreen /><Toasts /></>);
  return (
    <ReactFlowProvider>
      <Workspace />
    </ReactFlowProvider>
  );
}

function Workspace() {
  const dialog = useStore((s) => s.dialog);
  const openTaskId = useStore((s) => s.openTaskId);
  const wf = useStore((s) => s.wf);
  const panels = useStore((s) => s.panels);
  const togglePanel = useStore((s) => s.togglePanel);
  const simulating = useStore((s) => !!s.sim);
  useShortcuts();
  return (
    <div className={`app${simulating ? ' simulating' : ''}`}>
      <Toolbar />
      <ConflictBanner />
      <div className="stage">
        <main className="stage-canvas" aria-label={simulating ? 'Simulation canvas' : 'Workflow canvas'}>
          <SimulationOverlay />
          <Canvas />
          {panels.inspector && wf && (
            <FloatingPanel id="inspector" title="Inspector" icon="☰" width={400} height={640} initial={() => ({ x: 72, y: 60 })} onClose={() => togglePanel('inspector', false)}>
              <Inspector />
            </FloatingPanel>
          )}
          {panels.logs && (
            <div className="logs-drawer">
              <Timeline onClose={() => togglePanel('logs', false)} />
            </div>
          )}
        </main>
        {wf && <RightDock />}
      </div>
      <NodeSearch />
      {dialog === 'connections' && <Connections />}
      {dialog === 'ask' && wf && <AskClaude />}
      {dialog === 'newWorkflow' && <NewWorkflow />}
      {dialog === 'validate' && <ValidateDialog />}
      {dialog === 'help' && <HelpDialog />}
      {dialog === 'import' && <ImportProject />}
      {dialog === 'deleteWorkflow' && <DeleteWorkflowDialog />}
      {dialog === 'simReview' && <SimReviewDialog />}
      {openTaskId && <TaskDetail />}
      <Toasts />
    </div>
  );
}

function useShortcuts() {
  const rf = useReactFlow();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      const mod = e.ctrlKey || e.metaKey;
      const t = e.target as HTMLElement;
      const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable;
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); void draftState.save(); return; }
      if (s.dialog || s.openTaskId || s.nodeSearch) return; // modals handle their own keys
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        const r = document.querySelector('.canvas')?.getBoundingClientRect();
        s.set({ nodeSearch: r ? { x: r.left + r.width / 2 - 160, y: r.top + r.height / 3 } : { x: 200, y: 120 } });
        return;
      }
      if (mod && e.key === 'Enter') { e.preventDefault(); void s.startRun(); return; }
      if (typing) return;
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); void s.doUndo(); return; }
      if (mod && ((e.key.toLowerCase() === 'z' && e.shiftKey) || e.key.toLowerCase() === 'y')) { e.preventDefault(); void s.doRedo(); return; }
      if (mod || e.altKey) return;
      if (e.key === 'Escape') { s.select(null); return; }
      if (e.key === 'f') { void rf.fitView({ padding: 0.15, duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 200 }); return; }
      if (e.key === 'i') { s.togglePanel('inspector'); return; }
      if (e.key === 'H') { s.toggleRight('history'); return; }
      const tool = ({ v: 'select', r: 'marquee', h: 'hand', n: 'node' } as const)[e.key as 'v' | 'r' | 'h' | 'n'];
      if (tool) { s.setTool(tool); return; }
      if (e.key === 'l') { s.togglePanel('logs'); return; }
      if (e.key === '?') { s.set({ dialog: 'help' }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rf]);
}
