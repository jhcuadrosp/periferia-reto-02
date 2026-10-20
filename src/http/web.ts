import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export type WebAsset = { body: string | Blob; contentType: string };
let assets: Promise<ReadonlyMap<string, WebAsset>> | undefined;

// Compilar una vez por proceso y solo en memoria: sin dist/, sin tocar out/ ni incluir variables privadas.
export function webAssets(): Promise<ReadonlyMap<string, WebAsset>> {
  assets ??= (async () => {
    const [html, css, build] = await Promise.all([
      readFile(new URL("../../web/index.html", import.meta.url), "utf8"),
      readFile(new URL("../../web/styles.css", import.meta.url), "utf8"),
      Bun.build({ entrypoints: [fileURLToPath(new URL("../../web/app.ts", import.meta.url))],
        target: "browser", format: "esm", minify: true, sourcemap: "none", env: "disable" }),
    ]);
    if (!build.success || build.outputs.length !== 1) throw new Error("No se pudo compilar la interfaz web.");
    return new Map<string, WebAsset>([["/", { body: html, contentType: "text/html; charset=utf-8" }],
      ["/assets/styles.css", { body: css, contentType: "text/css; charset=utf-8" }],
      ["/assets/app.js", { body: build.outputs[0]!, contentType: "text/javascript; charset=utf-8" }]]);
  })();
  return assets;
}
