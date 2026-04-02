import { randomUUID } from "node:crypto";
import type { MemoryStore } from "./store.js";

export interface SessionInfo {
  id: string;
  model: string;
  policyName: string;
  turnCount: number;
}

export function createSession(
  store: MemoryStore,
  model: string,
  policyName: string
): SessionInfo {
  const id = randomUUID();
  store.upsertSession(id, model, policyName);
  return { id, model, policyName, turnCount: 0 };
}

export function nextTurn(session: SessionInfo, store: MemoryStore): SessionInfo {
  store.incrementTurn(session.id);
  return { ...session, turnCount: session.turnCount + 1 };
}

export function endSession(session: SessionInfo, store: MemoryStore): void {
  store.endSession(session.id);
}
