//
// In-process pub/sub. The external engine offered durable streams; in a
// single-process kernel a plain EventEmitter satisfies both the
// `durable:subscriber` topic triggers (events.ts) and the
// `stream::set` / `stream::send` surface that observe.ts fires for the
// live viewer. Durability is effectively unused: the four durable
// topics duplicate paths already reachable synchronously via trigger.

import { EventEmitter } from "node:events";

/** A stream item as emitted by `stream::set` / `stream::send`. */
export interface StreamItem {
  stream_name?: string;
  group_id?: string;
  item_id?: string;
  id?: string;
  type?: string;
  data?: unknown;
}

export class PubSub {
  private emitter = new EventEmitter();

  constructor() {
    // The viewer/stream listeners are best-effort; never let an absent
    // listener or a throwing one crash the process.
    this.emitter.setMaxListeners(0);
    this.emitter.on("error", () => {
      /* swallow: pub/sub is best-effort */
    });
  }

  /** Subscribe to a durable topic (used by `durable:subscriber`). */
  subscribe(topic: string, handler: (payload: unknown) => void): void {
    this.emitter.on(topicKey(topic), handler);
  }

  /** Publish to a durable topic. */
  publish(topic: string, payload: unknown): void {
    this.emitter.emit(topicKey(topic), payload);
  }

  /** Subscribe to the live stream surface (viewer wiring). */
  onStream(handler: (item: StreamItem) => void): void {
    this.emitter.on("stream", handler);
  }

  /** Emit a stream item. Mirrors `stream::set` / `stream::send`. */
  emitStream(item: StreamItem): void {
    this.emitter.emit("stream", item);
  }
}

function topicKey(topic: string): string {
  return `topic:${topic}`;
}
