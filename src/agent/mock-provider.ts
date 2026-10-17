import type { Provider, ProviderRequest } from "./provider.ts";

type Step = unknown | ((request: ProviderRequest) => unknown | Promise<unknown>);
// Un guion por sesión: no interpreta lenguaje ni toma decisiones contractuales.
export function createMockProvider(steps: Step[]): Provider {
  const positions = new Map<string, number>();
  return { async send(request) {
    const index = positions.get(request.sessionId) ?? 0;
    positions.set(request.sessionId, index + 1);
    if (index >= steps.length) return { type: "final", text: "La simulación ha terminado." };
    const step = steps[index];
    return typeof step === "function" ? step(request) : structuredClone(step);
  } };
}
