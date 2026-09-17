import type { State } from "./types";

// Preserve the existing Claude-first choice for older settings or a removed default.
export function defaultConnector(state: Pick<State, "keys" | "defaultKeyId">) {
  return state.keys.find((key) => key.id === state.defaultKeyId)
    ?? state.keys.find((key) => key.provider === "claude")
    ?? state.keys[0];
}
