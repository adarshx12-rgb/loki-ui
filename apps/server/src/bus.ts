import { EventEmitter } from 'node:events';
import type { BusEvent } from '@nodepilot/shared';

export interface BusEnvelope {
  id: number;
  event: BusEvent;
}

/**
 * In-process event bus feeding the SSE stream. Keeps a bounded ring buffer so
 * reconnecting clients can resume with Last-Event-ID; if they fell too far
 * behind they are told to resync (refetch state).
 */
export class Bus {
  private emitter = new EventEmitter();
  private buffer: BusEnvelope[] = [];
  private nextId = 1;
  constructor(private readonly capacity = 1000) {
    this.emitter.setMaxListeners(100);
  }

  publish(event: BusEvent): void {
    const env = { id: this.nextId++, event };
    this.buffer.push(env);
    if (this.buffer.length > this.capacity) this.buffer.shift();
    this.emitter.emit('event', env);
  }

  subscribe(fn: (e: BusEnvelope) => void): () => void {
    this.emitter.on('event', fn);
    return () => this.emitter.off('event', fn);
  }

  /** Events after `lastId`, or `null` if they are no longer buffered (client must resync). */
  since(lastId: number): BusEnvelope[] | null {
    if (lastId >= this.nextId) return null; // id from a previous server process
    const oldest = this.buffer[0]?.id ?? this.nextId;
    if (lastId + 1 < oldest) return null;
    return this.buffer.filter((e) => e.id > lastId);
  }
}
