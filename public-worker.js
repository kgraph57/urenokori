const ASSET_PATHS = new Set(["/", "/index.html", "/sample-note.png", ...["evening", "morning", "mame", "dora", "kuri", "kusa", "monaka", "neri"].map(name => `/assets/design/${name}.jpg`)]);
const HEADERS = {
  "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Cache-Control": "no-cache",
};

export default {
  async fetch(request, env) {
    if (!['GET', 'HEAD'].includes(request.method)) {
      return new Response("この見本では写真を送信できません。", { status: 405, headers: { ...HEADERS, Allow: "GET, HEAD" } });
    }
    const url = new URL(request.url);
    if (!ASSET_PATHS.has(url.pathname)) {
      return new Response("見つかりません。", { status: 404, headers: HEADERS });
    }
    if (url.pathname === "/") url.pathname = "/index.html";
    const asset = await env.ASSETS.fetch(new Request(url, request));
    const headers = new Headers(asset.headers);
    for (const [name, value] of Object.entries(HEADERS)) headers.set(name, value);
    return new Response(asset.body, { status: asset.status, headers });
  },
};
