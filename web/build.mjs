// Builds both versions from web/src:
//   web/index.html   -> claude.ai artifact (uses the viewer's Claude account)
//   site/index.html  -> static site for Netlify (uses the trader's own API key)
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const root = new URL("..", import.meta.url);
const template = await readFile(new URL("web/src/template.html", root), "utf8");

async function bundle(entry) {
  const out = await build({
    entryPoints: [new URL(entry, root).pathname],
    bundle: true, format: "iife", target: "es2020", minify: true, write: false, legalComments: "none",
  });
  // keep "</script>" inside strings from closing the inline tag
  return out.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
}

const fill = (html, js) => html.replace("/*BUNDLE*/", () => js);

const artifact = fill(template.replace(/<!--SITE-->[\s\S]*?<!--\/SITE-->\n?/, ""), await bundle("web/src/main-artifact.js"));
await writeFile(new URL("web/index.html", root), artifact);

const siteBody = fill(template.replace(/<!--\/?SITE-->\n?/g, ""), await bundle("web/src/main-site.js"));
const site = `<!doctype html>
<html lang="ur">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
</head>
<body>
${siteBody}
</body>
</html>
`;
await mkdir(new URL("site", root), { recursive: true });
await writeFile(new URL("site/index.html", root), site);
console.log(`web/index.html ${(artifact.length / 1024).toFixed(0)} KB, site/index.html ${(site.length / 1024).toFixed(0)} KB`);
