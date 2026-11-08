type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const keyOf = (chatId: string) => `pi-spore:draft:${chatId}`;

/** The unsent text saved for a chat, or "" when there is none. Throws if the storage is blocked. */
export function readDraft(storage: DraftStorage, chatId: string): string {
  const stored: unknown = storage.getItem(keyOf(chatId));
  return typeof stored === "string" ? stored : "";
}

export function clearDraft(storage: DraftStorage, chatId: string): void {
  storage.removeItem(keyOf(chatId));
}

/** Saves the unsent text of a chat. Empty text clears the draft. Throws if the storage is full or blocked. */
export function writeDraft(storage: DraftStorage, chatId: string, text: string): void {
  if (text === "") clearDraft(storage, chatId);
  else storage.setItem(keyOf(chatId), text);
}
