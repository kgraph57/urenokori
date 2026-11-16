import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, copyFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, ".public");
const sample = JSON.parse(await readFile(path.join(root, "public-sample.json"), "utf8"));
const html = await readFile(path.join(root, "public-app.html"), "utf8");
const designNames = ["evening", "morning", "mame", "dora", "kuri", "kusa", "monaka", "neri"];
const files = ["index.html", "sample-note.png", ...designNames.map(name => `assets/design/${name}.jpg`)];
const embedded = html.match(/const SAMPLES = (\[[^\n]+\]);/);
assert(embedded, "Missing public sample");
const samples = JSON.parse(embedded[1]);
assert.equal(samples.length, 1);
assert.deepEqual(samples[0].items.map(item => item.count), sample.result.urenokori.map(item => item.kazu));
assert.deepEqual(samples[0].items.map(item => item.name), sample.result.urenokori.map(item => item.na));

for (const forbidden of ['type="file"', 'fetch(', 'XMLHttpRequest', 'ANTHROPIC_', 'URENOKORI_LIVE', 'scanFile']) {
  assert(!html.includes(forbidden), `Public output contains ${forbidden}`);
}
for (const reference of html.matchAll(/(?:src|href)="(\/[^"#]+)"/g)) {
  assert(files.includes(reference[1].slice(1)), `Asset is not allowed: ${reference[1]}`);
}
const photo = await readFile(path.join(root, "assets/sample-note.png"));
assert.equal(createHash("sha256").update(photo).digest("hex"), sample.sha256);
await mkdir(output, { recursive: true });
async function checkOutput(directory, prefix = "") {
  for (const name of await readdir(directory)) {
    const relative = prefix + name;
    if ((await stat(path.join(directory, name))).isDirectory()) {
      assert(files.some(file => file.startsWith(`${relative}/`)), `Unexpected output directory: ${relative}`);
      await checkOutput(path.join(directory, name), `${relative}/`);
    } else assert(files.includes(relative), `Unexpected output file: ${relative}`);
  }
}
await checkOutput(output);
await writeFile(path.join(output, "index.html"), html);
for (const file of files.slice(1)) {
  await mkdir(path.dirname(path.join(output, file)), { recursive: true });
  await copyFile(path.join(root, file === "sample-note.png" ? "assets/sample-note.png" : file), path.join(output, file));
}
console.log(JSON.stringify({ files, htmlSha256: createHash("sha256").update(html).digest("hex"), photoSha256: sample.sha256, apiEnabled: false }));
