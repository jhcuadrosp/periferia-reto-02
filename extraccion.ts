import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractContract } from "./src/domain/extraction.ts";
import { readText } from "./src/storage/files.ts";
import { readMailbox } from "./src/storage/mailbox.ts";

const directory = fileURLToPath(new URL("./fixtures/reto-02/buzon/", import.meta.url));
const mailbox = await readMailbox(directory);
if (!mailbox.ok) {
  console.log(JSON.stringify(mailbox, null, 2));
  process.exitCode = 1;
} else {
  const results = [];
  for (const message of mailbox.data) {
    if (message.problemas.some((problem) => problem.nivel === "error")) process.exitCode = 1;
    results.push({ mensaje_id: message.correo?.id ?? message.carpeta, problemas: message.problemas,
      documentos: await Promise.all(message.adjuntos.filter((attachment) => attachment.legible && attachment.formato === ".txt")
        .map(async (attachment) => {
          const archivo = join(directory, message.carpeta, attachment.nombre);
          const result = await readText(archivo);
          if (!result.ok) { process.exitCode = 1; return { archivo, ...result }; }
          return { archivo, resultado: extractContract(result.data) };
        })),
    });
  }
  console.log(JSON.stringify(results, null, 2));
}
