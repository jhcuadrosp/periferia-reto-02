import { test as bunTest } from "bun:test";

// Cada archivo crea su propio seguimiento; no comparte temporales con otra suite.
export function integrationTests() {
  const running: Promise<void>[] = [];
  function test(name: string, body: () => void | Promise<void>) {
    bunTest(name, () => {
      const operation = Promise.resolve().then(body);
      running.push(operation);
      return operation;
    }, 30_000);
  }
  async function waitForCompletion() {
    // El timeout del runner falla el caso, pero no cancela sus operaciones de I/O.
    // Esperar aquí evita borrar archivos durante el commit o su recuperación.
    await Promise.allSettled(running.splice(0));
  }
  return { test, waitForCompletion };
}
