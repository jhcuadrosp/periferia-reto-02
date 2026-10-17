import { expect, test } from "bun:test";
import { execPath } from "node:process";
import { fileURLToPath } from "node:url";
import { z } from "zod";

test("Bun ejecuta el punto de entrada TypeScript", async () => {
  const subprocess = Bun.spawn([execPath, "run", "index.ts"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    stdout: "pipe",
    stderr: "pipe",
  });

  const output = await new Response(subprocess.stdout).text();
  const error = await new Response(subprocess.stderr).text();

  expect(await subprocess.exited).toBe(0);
  expect(error).toBe("");
  expect(output.trim()).toBe(
    "Hola Javier, bienvenido al Reto 2 de Periferia IT Group",
  );
});

test("Zod está disponible y valida entradas en ejecución", () => {
  const text = z.string();

  expect(text.safeParse("configuración lista").success).toBe(true);
  expect(text.safeParse(2).success).toBe(false);
});
