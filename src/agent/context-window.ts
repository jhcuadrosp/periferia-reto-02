import type { Message } from "./provider.ts";

// Ventana por turnos completos: nunca corta un lote ni separa llamadas/resultados.
// El historial local y los eventos completos siguen disponibles para auditoría.
export function contextWindow(messages: Message[], turns = 4): Message[] {
  const starts = messages.flatMap((message, index) => message.role === "user" ? [index] : []);
  return messages.slice(starts.length > turns ? starts[starts.length - turns]! : 0);
}
