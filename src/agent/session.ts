import { randomUUID } from "node:crypto";
import type { Message } from "./provider.ts";
import type { RegistrationTicket } from "../storage/persistence.ts";
import type { Reviewer } from "../domain/review.ts";
import type { Extraction } from "../domain/schemas.ts";

export type AgentEvent = { type: "tool"; id: string; name: string; arguments: string; result: string }
  | { type: "review_required"; mensaje_id: string; fields: string[] }
  | { type: "approval_request"; solicitud_id: string; datos_hash: string; values: unknown; reviewer: string }
  | { type: "decision"; solicitud_id: string; action: "aprobar" | "rechazar"; reviewer: string };
export type Binding = { ticket: RegistrationTicket; datos_hash: string; reviewer: Reviewer; state: "pendiente" | "aprobada" | "rechazada" | "utilizada" };
export type ToolReference = { mensaje_id: string; kind: "extraction" | "ticket"; hash: string; value: Extraction | RegistrationTicket };
export type Session = { id: string; messages: Message[]; events: AgentEvent[]; tokens: number; usageComplete: boolean;
  busy: boolean; callIds: Set<string>; tickets: Map<string, RegistrationTicket>; approvals: Map<string, Binding>;
  references: Map<string, ToolReference> };

export function createSessionStore() {
  const sessions = new Map<string, Session>();
  return {
    create() {
      const id = randomUUID();
      sessions.set(id, { id, messages: [], events: [], tokens: 0, usageComplete: true, busy: false,
        callIds: new Set(), tickets: new Map(), approvals: new Map(), references: new Map() });
      return id;
    },
    get(id: string) {
      const session = sessions.get(id);
      if (!session) throw new Error("Sesión inexistente.");
      return session;
    },
    view(id: string) {
      const session = this.get(id);
      return structuredClone({ id, messages: session.messages, events: session.events, tokens: session.tokens, usageComplete: session.usageComplete });
    },
  };
}
