import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { evaluateRegistration, initializeStorage, persistRegistration, resetStorage } from "./src/storage/persistence.ts";
import { readMailbox } from "./src/storage/mailbox.ts";
import { readCsv } from "./src/storage/csv.ts";

const directory = fileURLToPath(new URL("./", import.meta.url));
const initialization = Bun.argv.includes("--reiniciar-demostracion")
  ? await resetStorage(directory, "demostracion") : await initializeStorage(directory);
if (!initialization.ok) { console.error(initialization.error); process.exitCode = 1; }
else {
  const before = await readCsv(join(directory, "out/sharepoint/maestro-contratos.csv"));
  const mailbox = await readMailbox(join(directory, "fixtures/reto-02/buzon"));
  const results = [];
  if (!mailbox.ok) { console.error(mailbox.problemas); process.exitCode = 1; }
  else for (const message of mailbox.data) {
    if (!message.correo || message.problemas.some((problem) => problem.nivel === "error")) {
      results.push({ mensaje_id: message.carpeta, problemas: message.problemas }); process.exitCode = 1; continue;
    }
    if (message.correo.adjuntos.length > 1 || (message.adjuntos.length && message.adjuntos[0]?.formato !== ".txt")) {
      results.push({ mensaje_id: message.carpeta, error: "Selecciona explícitamente un único adjunto TXT antes de registrar." }); process.exitCode = 1; continue;
    }
    const evaluated = await evaluateRegistration(directory, message.correo.id, message.correo.adjuntos[0] ?? null);
    const result = evaluated.ok ? await persistRegistration(directory, evaluated.data) : evaluated;
    results.push(result);
    if (!result.ok) process.exitCode = 1;
  }
  const after = await readCsv(join(directory, "out/sharepoint/maestro-contratos.csv"));
  console.log(JSON.stringify({ antes: before.ok ? before.data.registros.length : null,
    despues: after.ok ? after.data.registros.length : null, resultados: results }, null, 2));
}
