import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { diagnoseCommercials, diagnoseMaster } from "./src/domain/quality.ts";
import { readCsv } from "./src/storage/csv.ts";
import { readJson, type Problem } from "./src/storage/files.ts";
import { readMailbox } from "./src/storage/mailbox.ts";

const directory = fileURLToPath(new URL("./fixtures/reto-02/", import.meta.url));
const masterFile = join(directory, "maestro-contratos.csv");
const commercialFile = join(directory, "comerciales.json");
const [master, commercials, mailbox] = await Promise.all([
  readCsv(masterFile), readJson(commercialFile), readMailbox(join(directory, "buzon")),
]);
const masterReport = master.ok ? diagnoseMaster(master.data, masterFile) : master;
const commercialReport = commercials.ok ? diagnoseCommercials(commercials.data, commercialFile) : commercials;
const report = { maestro: masterReport, comerciales: commercialReport, buzon: mailbox };

console.log(JSON.stringify(report, null, 2));

// Los errores producen una salida distinta de cero, pero no evitan explorar otros archivos.
const problems: Problem[] = [...masterReport.problemas, ...commercialReport.problemas,
  ...(mailbox.ok ? mailbox.data.flatMap((message) => message.problemas) : mailbox.problemas)];
if (problems.some((problem) => problem.nivel === "error")) process.exitCode = 1;
