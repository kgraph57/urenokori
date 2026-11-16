import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../public-worker.js";

test("allowed assets are served and cannot initiate a network connection", async () => {
  for (const pathname of ["/", "/index.html", "/sample-note.png", ...["evening", "morning", "mame", "dora", "kuri", "kusa", "monaka", "neri"].map(name => `/assets/design/${name}.jpg`)]) {
    let calls = 0;
    const response = await worker.fetch(new Request(`https://example.test${pathname}`), {
      ASSETS: { fetch: async (request) => {
        calls++;
        assert.equal(new URL(request.url).pathname, pathname === "/" ? "/index.html" : pathname);
        return new Response("asset");
      } },
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "asset");
    assert.equal(calls, 1);
    assert.match(response.headers.get("Content-Security-Policy"), /connect-src 'none'/);
  }
});

test("private files and the AI endpoint never reach the asset binding", async () => {
  for (const pathname of ["/yomu", "/.env", "/.env.local", "/README.md", "/CLAUDE.md", "/server.js", "/yomu.js", "/public-sample.json", "/tameshi/shashin/p03.png"]) {
    const response = await worker.fetch(new Request(`https://example.test${pathname}`), {
      ASSETS: { fetch: async () => { throw Error("Private path reached assets"); } },
    });
    assert.equal(response.status, 404, pathname);
  }
});

test("uploads are rejected before any asset or API call", async () => {
  for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
    const response = await worker.fetch(new Request("https://example.test/yomu", { method }), {
      ASSETS: { fetch: async () => { throw Error("Upload reached assets"); } },
    });
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get("Allow"), "GET, HEAD");
  }
});
