import type { ApiKey, State } from "./types";

// Preserve the existing Claude-first choice for older settings or a removed default.
export function defaultConnector(state: Pick<State, "keys" | "defaultKeyId">) {
  return state.keys.find((key) => key.id === state.defaultKeyId)
    ?? state.keys.find((key) => key.provider === "claude")
    ?? state.keys[0];
}

// Older settings stored model choices only on chats. Reuse the most recent one.
export function selectedModel(state: Pick<State, "chats">, key: ApiKey, fallback: string): string {
  if (key.defaultModel) return key.defaultModel;
  const chats = state.chats.filter((chat) => chat.keyId === key.id && chat.provider === key.provider);
  const activity = (chat: State["chats"][number]) => chat.messages.reduce((latest, message) => Math.max(latest, message.ts), chat.lastChattedAt ?? 0);
  return chats.reduce<State["chats"][number] | undefined>((latest, chat) => !latest || activity(chat) >= activity(latest) ? chat : latest, undefined)?.model || fallback;
}
