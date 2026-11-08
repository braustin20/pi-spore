import { describe, expect, it } from "vitest";
import { clearDraft, readDraft, writeDraft } from "./drafts.js";

/** A Map-backed stand-in for localStorage. */
const memory = () => {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
};

describe("drafts", () => {
  it("gives back what was written, per chat", () => {
    const storage = memory();
    writeDraft(storage, "A", "hello");
    writeDraft(storage, "B", "other");
    expect(readDraft(storage, "A")).toBe("hello");
    expect(readDraft(storage, "B")).toBe("other");
    expect(storage.items.get("pi-spore:draft:A")).toBe("hello");
  });

  it("gives an empty string when nothing is saved", () => {
    expect(readDraft(memory(), "A")).toBe("");
  });

  it("clears a draft, and writing empty text clears it too", () => {
    const storage = memory();
    writeDraft(storage, "A", "hello");
    clearDraft(storage, "A");
    expect(readDraft(storage, "A")).toBe("");
    writeDraft(storage, "A", "again");
    writeDraft(storage, "A", "");
    expect(storage.items.size).toBe(0);
  });

  it("ignores a stored value that is not a string", () => {
    const storage = { getItem: () => 42 as unknown as string, setItem() {}, removeItem() {} };
    expect(readDraft(storage, "A")).toBe("");
  });
});
