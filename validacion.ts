import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractContract } from "./src/domain/extraction.ts";
import { diagnoseCommercials, diagnoseMaster } from "./src/domain/quality.ts";
import { validateContract } from "./src/domain/validation.ts";
import { readCsv } from "./src/storage/csv.ts";
import { readJson, readText } from "./src/storage/files.ts";
import { readMailbox } from "./src/storage/mailbox.ts";

const directory = fileURLToPath(new URL("./fixtures/reto-02/", import.meta.url));
const masterFile = join(directory, "maestro-contratos.csv");
const commercialFile = join(directory, "comerciales.json");
const [master, commercials, mailbox] = await Promise.all([
  readCsv(masterFile), readJson(commercialFile), readMailbox(join(directory, "buzon")),
]);
if (!master.ok || !commercials.ok || !mailbox.ok) {
  console.log(JSON.stringify({ master, commercials, mailbox }, null, 2));
  process.exitCode = 1;
} else {
  const masterReport = diagnoseMaster(master.data, masterFile);
  const commercialReport = diagnoseCommercials(commercials.data, commercialFile);
  if ([...masterReport.problemas, ...commercialReport.problemas].some((problem) => problem.nivel === "error") || masterReport.duplicados.length || commercialReport.duplicados.length) {
    console.log(JSON.stringify({ masterReport, commercialReport }, null, 2));
    process.exitCode = 1;
  } else {
    const results = [];
    for (const message of mailbox.data) {
      if (!message.correo || message.problemas.some((problem) => problem.nivel === "error")) {
        results.push({ mensaje_id: message.carpeta, problemas: message.problemas });
        process.exitCode = 1;
        continue;
      }
      const documents = message.adjuntos.filter((attachment) => attachment.legible && attachment.formato === ".txt");
      if (!message.correo.adjuntos.length) {
        results.push(validateContract(null, message.correo, masterReport.registros, commercialReport.registros));
      } else if (!documents.length) {
        results.push({ mensaje_id: message.correo.id, error: "No hay un formato TXT soportado para evaluar; no se clasifica un documento que no se ha podido leer." });
        process.exitCode = 1;
      }
      for (const document of documents) {
        const text = await readText(join(directory, "buzon", message.carpeta, document.nombre));
        if (!text.ok) { results.push(text); process.exitCode = 1; continue; }
        results.push(validateContract(extractContract(text.data), message.correo, masterReport.registros, commercialReport.registros));
      }
    }
    console.log(JSON.stringify(results, null, 2));
  }
}
