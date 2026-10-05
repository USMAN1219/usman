// Inlines the instant-link build into one HTML page (dist-artifact/price-action-analyst.html).
import { readdir, readFile, writeFile } from "node:fs/promises";

const dir = "dist-artifact";
const files = await readdir(dir);
const js = await readFile(`${dir}/app.js`, "utf8");
const cssFile = files.find((f) => f.endsWith(".css"));
const css = cssFile ? await readFile(`${dir}/${cssFile}`, "utf8") : "";
const safeJs = js.replaceAll("</script", "<\\/script");
const html = `<title>Price Action Analyst</title>
<style>${css}</style>
<div id="root"></div>
<script>${safeJs}</script>
`;
await writeFile(`${dir}/price-action-analyst.html`, html);
console.log(`${dir}/price-action-analyst.html ${(html.length / 1024).toFixed(0)} KB`);
