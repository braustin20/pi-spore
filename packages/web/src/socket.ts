type Listener = (event: unknown) => void;

interface Frame {
  type: "event" | "error";
  topic?: string;
  event?: unknown;
  message?: string;
}

const MAX_BACKOFF_MS = 10_000;

/**
 * One WebSocket per page, shared by every subscription. After a drop it reconnects with backoff and subscribes to
 * every topic again; the server answers each subscription with a fresh snapshot, so listeners catch up by
 * themselves.
 */
export class EventSocket {
  private socket: WebSocket | undefined;
  private readonly listeners = new Map<string, Set<Listener>>();
  private backoff = 500;

  constructor(private readonly url: string) {}

  subscribe(topic: string, listener: Listener): () => void {
    let set = this.listeners.get(topic);
    if (!set) {
      set = new Set();
      this.listeners.set(topic, set);
      this.sendIfOpen({ type: "subscribe", topic });
    }
    set.add(listener);
    this.ensureOpen();
    return () => {
      const current = this.listeners.get(topic);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.listeners.delete(topic);
        this.sendIfOpen({ type: "unsubscribe", topic });
      }
    };
  }

  private ensureOpen(): void {
    if (this.socket) return;
    const socket = new WebSocket(this.url);
    this.socket = socket;
    socket.addEventListener("open", () => {
      this.backoff = 500;
      for (const topic of this.listeners.keys())
        socket.send(JSON.stringify({ type: "subscribe", topic }));
    });
    socket.addEventListener("message", (message) => {
      let frame: Frame;
      try {
        frame = JSON.parse(String(message.data)) as Frame;
      } catch {
        return;
      }
      if (frame.type === "error") {
        console.error(
          `pi-spore event error${frame.topic ? ` (${frame.topic})` : ""}: ${frame.message}`,
        );
        return;
      }
      if (frame.topic === undefined) return;
      for (const listener of this.listeners.get(frame.topic) ?? []) listener(frame.event);
    });
    socket.addEventListener("close", () => {
      this.socket = undefined;
      if (this.listeners.size === 0) return;
      setTimeout(() => this.ensureOpen(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    });
  }

  private sendIfOpen(message: { type: string; topic: string }): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }
}
