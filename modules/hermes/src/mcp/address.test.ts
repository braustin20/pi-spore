// The Tailscale address lookup reads FAKE network interfaces here; it never runs the `tailscale` CLI (ADR 0143).
import type { NetworkInterfaceInfo } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";

const interfaces = vi.hoisted(() => ({ value: {} as Record<string, NetworkInterfaceInfo[]> }));
vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  networkInterfaces: () => interfaces.value,
}));

const { findTailscaleAddress } = await import("./listener.js");

const v4 = (address: string): NetworkInterfaceInfo => ({
  address,
  netmask: "255.255.255.0",
  family: "IPv4",
  mac: "00:00:00:00:00:00",
  internal: false,
  cidr: `${address}/24`,
});

beforeEach(() => {
  interfaces.value = {};
});

describe("findTailscaleAddress (FAKE interfaces)", () => {
  it("takes the 100.64.0.0/10 address of a Tailscale interface, never a LAN or loopback one", () => {
    interfaces.value = {
      lo: [{ ...v4("127.0.0.1"), internal: true }],
      eth0: [v4("192.168.1.20"), v4("100.70.0.9")],
      tailscale0: [v4("100.118.5.45")],
    };
    expect(findTailscaleAddress()).toBe("100.118.5.45");
  });

  it("finds none without a Tailscale interface, or with an address outside 100.64.0.0/10", () => {
    interfaces.value = { eth0: [v4("100.70.0.9")], tailscale0: [v4("100.128.0.1")] };
    expect(findTailscaleAddress()).toBeUndefined();
  });
});
