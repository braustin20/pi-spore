import { afterEach, describe, expect, it, vi } from "vitest";
import { EventSocket } from "./socket.js";

/** A WebSocket that records what the page sends and lets the test open it. */
class FakeWebSocket extends EventTarget {
  static readonly OPEN = 1;
  static last: FakeWebSocket | undefined;
  readyState = 0;
  readonly sent: unknown[] = [];

  constructor(readonly url: string) {
    super();
    FakeWebSocket.last = this;
  }

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeWebSocket.last = undefined;
});

const openSocket = () => {
  vi.stubGlobal("WebSocket", FakeWebSocket);
  return new EventSocket("ws://test/api/ws");
};

describe("EventSocket", () => {
  it("subscribes once for the listeners present when the socket opens", () => {
    const events = openSocket();
    events.subscribe("agents:list", () => {});
    events.subscribe("agents:list", () => {});
    FakeWebSocket.last?.open();
    expect(FakeWebSocket.last?.sent).toEqual([{ type: "subscribe", topic: "agents:list" }]);
  });

  it("asks for a fresh snapshot when a listener joins a topic that is already open", () => {
    const events = openSocket();
    events.subscribe("agents:list", () => {});
    FakeWebSocket.last?.open();
    events.subscribe("agents:list", () => {});
    expect(FakeWebSocket.last?.sent).toEqual([
      { type: "subscribe", topic: "agents:list" },
      { type: "subscribe", topic: "agents:list" },
    ]);
  });

  it("unsubscribes only when the last listener of a topic leaves", () => {
    const events = openSocket();
    const first = events.subscribe("agents:list", () => {});
    FakeWebSocket.last?.open();
    const second = events.subscribe("agents:list", () => {});
    first();
    expect(FakeWebSocket.last?.sent).not.toContainEqual({
      type: "unsubscribe",
      topic: "agents:list",
    });
    second();
    expect(FakeWebSocket.last?.sent).toContainEqual({ type: "unsubscribe", topic: "agents:list" });
  });
});
