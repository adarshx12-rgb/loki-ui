import type { BusEvent } from '@nodepilot/shared';
import { useStore } from './store';

/**
 * Live updates over Server-Sent Events. EventSource reconnects automatically and
 * sends Last-Event-ID; if the server can no longer replay what we missed it sends
 * "resync" and we refetch everything.
 */
export function connectLive(): () => void {
  let es: EventSource | null = null;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const open = () => {
    if (closed) return;
    useStore.getState().set({ live: 'connecting' });
    es = new EventSource('/api/stream');
    es.onopen = () => useStore.getState().set({ live: 'live' });
    es.addEventListener('hello', () => void useStore.getState().refresh());
    es.addEventListener('resync', () => void useStore.getState().refresh());
    es.onmessage = (m) => {
      try {
        useStore.getState().onBus(JSON.parse(m.data) as BusEvent);
      } catch {
        /* ignore malformed */
      }
    };
    es.onerror = () => {
      useStore.getState().set({ live: 'offline' });
      if (es?.readyState === EventSource.CLOSED) {
        // e.g. 401 after the session expired, or the server restarted: retry, then re-check auth.
        es.close();
        retry = setTimeout(() => {
          void useStore.getState().init().then(open);
        }, 3000);
      }
    };
  };
  open();
  return () => {
    closed = true;
    clearTimeout(retry);
    es?.close();
  };
}
