import { afterEach, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { execPath } from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { optionalBytes } from "../src/storage/audit.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const created: string[] = [];
afterEach(async () => {
  const temporaryRoot = await realpath(tmpdir());
  for (const directory of created.splice(0)) {
    const resolved = await realpath(directory);
    const name = relative(temporaryRoot, resolved);
    if (isAbsolute(name) || name.startsWith(`..${sep}`) || name.includes(sep) || !name.startsWith("periferia-demo-")) {
      throw new Error("La prueba solo limpia sus directorios temporales propios.");
    }
    await rm(resolved, { recursive: true });
  }
});

async function subprocess(args: string[]) {
  const child = Bun.spawn([execPath, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  const directory = stdout.match(/^Directorio aislado: (.+)\r?$/m)?.[1]?.trim();
  if (directory) created.push(directory);
  return { stdout, stderr, exitCode, directory };
}

async function artifactBytes(directory: string, prefix = ""): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(result, await artifactBytes(join(directory, entry.name), name));
    else result[name] = (await readFile(join(directory, entry.name))).toString("base64");
  }
  return result;
}

test("Demo CLI desde cero dos veces: mismo resultado y salidas idénticas en carpetas diferentes", async () => {
  const first = await subprocess(["run", join(root, "demo.ts")]);
  const second = await subprocess(["run", join(root, "demo.ts")]);
  expect(first.stderr).toBe("");
  expect(second.stderr).toBe("");
  expect(first.exitCode).toBe(0);
  expect(second.exitCode).toBe(0);
  if (!first.directory || !second.directory) throw new Error("La demo no informó sus salidas.");
  expect(first.directory).not.toBe(second.directory);
  expect(first.stdout.replaceAll(first.directory, "<TEMP>")).toBe(second.stdout.replaceAll(second.directory, "<TEMP>"));
  expect(await artifactBytes(join(first.directory, "out"))).toEqual(await artifactBytes(join(second.directory, "out")));
  expect(first.stdout).toContain("Maestro: 8 → 10 → 10");
  expect(first.stdout).toContain("Resultado global: CORRECTO");
  expect(first.stdout).toContain("2 pólizas no vigentes, 2 altas desde el corte");
  expect(first.stdout).toContain("confirmado=true no concede autorización humana");
}, 120_000);

test("Una discrepancia real en copia de fixtures falla las aserciones y produce código 1", async () => {
  const source = await mkdtemp(join(tmpdir(), "periferia-demo-input-test-"));
  created.push(source);
  await cp(join(root, "fixtures"), join(source, "fixtures"), { recursive: true });
  await cp(join(root, "PRD.md"), join(source, "PRD.md"));
  const agents = await optionalBytes(join(root, "AGENTS.md"));
  if (agents !== null) await writeFile(join(source, "AGENTS.md"), agents);
  const path = join(source, "fixtures/reto-02/buzon/msg-003/otrosi.txt");
  const modified = (await readFile(path, "utf8")).replace("520,000.00", "521,000.00");
  await writeFile(path, modified);
  const code = `import { runDemo } from ${JSON.stringify(pathToFileURL(join(root, "demo.ts")).href)};
    const result = await runDemo(${JSON.stringify(source)}); process.exitCode = result.ok ? 0 : 1;`;
  const result = await subprocess(["--eval", code]);
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toContain("Resultado global: FALLIDO");
  expect(result.stdout).toContain("FALLO: Otrosí: 520000 PEN");
  expect(result.stdout).toContain("Pasada 2:");
  expect(await readFile(path, "utf8")).toBe(modified);
}, 120_000);
