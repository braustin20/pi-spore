import { ApiError, type EventHub, type Logger } from "@pi-spore/module-api";
import { WebSocket, WebSocketServer } from "ws";
import { keepAlive, type UpgradeHandler } from "./sockets.js";

type Handler = (topic: string) => unknown[] | Promise<unknown[]>;

/** A message from a browser, before it is checked: `{ type: "subscribe" | "unsubscribe", topic }`. */
interface ClientMessage {
  type?: unknown;
  topic?: unknown;
}

/** Per socket and topic: events published while the snapshot is being built wait in `queue`. */
interface Subscription {
  ready: boolean;
  queue: unknown[];
}

export class WebSocketHub implements EventHub {
  private readonly handlers: { prefix: string; handler: Handler }[] = [];
  private readonly subscriptions = new Map<WebSocket, Map<string, Subscription>>();
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  private readonly stopHeartbeat = keepAlive(this.wss);

  constructor(private readonly log: Logger) {}

  publish(topic: string, event: unknown): void {
    for (const [socket, topics] of this.subscriptions) {
      const subscription = topics.get(topic);
      if (!subscription) continue;
      if (subscription.ready) send(socket, topic, event);
      else subscription.queue.push(event);
    }
  }

  onSubscribe(prefix: string, handler: Handler): void {
    if (this.handlers.some((existing) => existing.prefix === prefix)) {
      throw new Error(`Event topic prefix "${prefix}" has two handlers`);
    }
    this.handlers.push({ prefix, handler });
  }

  /** Takes an upgrade at `/api/ws` that passed the guards in `attachUpgrades`. */
  readonly upgrade: UpgradeHandler = (request, socket, head) => {
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.wss.emit("connection", ws, request);
      this.accept(ws);
    });
  };

  close(): void {
    this.stopHeartbeat();
    for (const ws of this.wss.clients) ws.terminate();
    this.wss.close();
  }

  private accept(ws: WebSocket): void {
    this.subscriptions.set(ws, new Map());
    ws.on("close", () => this.subscriptions.delete(ws));
    ws.on("message", (data) => {
      let message: ClientMessage;
      try {
        message = JSON.parse(String(data)) as ClientMessage;
      } catch {
        return sendError(ws, undefined, "Messages must be JSON");
      }
      const topic = message?.topic;
      if (typeof topic !== "string") return sendError(ws, undefined, "Messages need a topic");
      if (message.type === "subscribe") void this.subscribe(ws, topic);
      else if (message.type === "unsubscribe") this.subscriptions.get(ws)?.delete(topic);
      else sendError(ws, topic, "Unknown message type");
    });
  }

  private async subscribe(ws: WebSocket, topic: string): Promise<void> {
    const topics = this.subscriptions.get(ws);
    if (!topics) return;
    const match = this.handlers
      .filter((candidate) => topic.startsWith(candidate.prefix))
      .sort((a, b) => b.prefix.length - a.prefix.length)[0];
    if (!match) return sendError(ws, topic, `No such topic: ${topic}`);

    const subscription: Subscription = { ready: false, queue: [] };
    topics.set(topic, subscription);
    let snapshot: unknown[];
    try {
      snapshot = await match.handler(topic);
    } catch (error) {
      topics.delete(topic);
      if (!(error instanceof ApiError))
        this.log.error("Event snapshot failed", { topic, error: String(error) });
      return sendError(
        ws,
        topic,
        error instanceof ApiError ? error.message : "Snapshot failed; see the server log",
      );
    }
    // The browser may have unsubscribed or resubscribed while the snapshot was built.
    if (topics.get(topic) !== subscription) return;
    for (const event of snapshot) send(ws, topic, event);
    for (const event of subscription.queue) send(ws, topic, event);
    subscription.queue = [];
    subscription.ready = true;
  }
}

function send(ws: WebSocket, topic: string, event: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "event", topic, event }));
}

function sendError(ws: WebSocket, topic: string | undefined, message: string): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "error", topic, message }));
}
