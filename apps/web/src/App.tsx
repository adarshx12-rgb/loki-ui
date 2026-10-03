import { useEffect } from 'react';
import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
import { useStore } from './store';
import { connectLive } from './sse';
import { Toolbar } from './components/Toolbar';
import { Palette } from './components/Palette';
import { Canvas } from './components/Canvas';
import { Inspector } from './inspector/Inspector';
import { Timeline } from './components/Timeline';
import { Connections } from './components/Connections';
import { AskClaude, TaskDetail } from './components/AskClaude';
import { ConflictBanner, HelpDialog, NewWorkflow, PairingScreen, Toasts, ValidateDialog } from './components/Dialogs';
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
  useShortcuts();
  return (
    <div className="app">
      <Toolbar />
      <ConflictBanner />
      <div className="main">
        <Palette />
        <main className="center" aria-label="Workflow canvas">
          <Canvas />
        </main>
        <Inspector />
      </div>
      <Timeline />
      {dialog === 'connections' && <Connections />}
      {dialog === 'ask' && wf && <AskClaude />}
      {dialog === 'newWorkflow' && <NewWorkflow />}
      {dialog === 'validate' && <ValidateDialog />}
      {dialog === 'help' && <HelpDialog />}
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
      if (s.dialog || s.openTaskId) return; // modals handle their own keys
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); document.getElementById('palette-search')?.focus(); return; }
      if (mod && e.key === 'Enter') { e.preventDefault(); void s.startRun(); return; }
      if (typing) return;
      if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); void s.doUndo(); return; }
      if (mod && ((e.key.toLowerCase() === 'z' && e.shiftKey) || e.key.toLowerCase() === 'y')) { e.preventDefault(); void s.doRedo(); return; }
      if (e.key === 'Escape') { s.select(null); return; }
      if (e.key === 'f' && !mod) { void rf.fitView({ padding: 0.15, duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 200 }); return; }
      if (e.key === '?') { s.set({ dialog: 'help' }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rf]);
}
