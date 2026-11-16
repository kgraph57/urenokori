// ───────────────────────────────────────────
// server.js — 取り次ぎ役（この Mac で動かす入口）。
//
//   ・画面（index.html）を配る
//   ・POST /yomu で写真を受け取り、yomu.js に渡して、読んだ数を返す
//   ・鍵（ANTHROPIC_API_KEY）はここだけが持つ。ブラウザには渡さない
//
// 動かし方:  node --env-file-if-exists=.env server.js   （npm start でも同じ）
// 環境変数:
//   ANTHROPIC_API_KEY     鍵（手元では .env に書く）
//   ANTHROPIC_AUTH_TOKEN  鍵の代わりのしるし。ANTHROPIC_API_KEY が無いときに使う。どちらか 1 つは必ず要る
//   PORT                  待ち受ける番号。無ければ 8787
//   AIKOTOBA           あいことば。入れると、画面からの合言葉が合わないときは読まない
//                      （インターネットに置くときに使う。手元で試すだけなら無くてよい）
// ───────────────────────────────────────────
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { yomu, shippaiHenji, MODEL } from "./yomu.js";

const KOKO = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8787;
const AIKOTOBA = process.env.AIKOTOBA || "";

// 鍵の渡し方。ANTHROPIC_API_KEY があればそれ、無ければ ANTHROPIC_AUTH_TOKEN
function kagiErabu() {
  const apiKey = process.env.ANTHROPIC_API_KEY || "";
  const authToken = process.env.ANTHROPIC_AUTH_TOKEN || "";
  if (apiKey) return { apiKey, namae: "ANTHROPIC_API_KEY" };
  if (authToken) return { authToken, namae: "ANTHROPIC_AUTH_TOKEN" };
  return { namae: "" };
}

const HONBUN_JOUGEN = 6 * 1024 * 1024;           // 受け取る本文の上限（6 MB）
const GAZOU_SHURUI = new Set(["image/jpeg", "image/png", "image/webp"]);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

// 1 分あたりの読み取り回数の上限（間違って連打したときや、知らない人に使われたときの歯止め）
const KAISUU_JOUGEN = 20;
let kaisuu = [];
function kaisuuOk() {
  const ima = Date.now();
  kaisuu = kaisuu.filter(t => ima - t < 60_000);
  if (kaisuu.length >= KAISUU_JOUGEN) return false;
  kaisuu.push(ima);
  return true;
}

// 画面が file:// や別の場所から呼んでも届くように（CORS）
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Aikotoba",
};

function okuruJSON(res, code, obj) {
  res.writeHead(code, { ...CORS, "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

// 本文を上限まで読む。超えたら null
function honbunYomu(req) {
  return new Promise((resolve, reject) => {
    const kakera = [];
    let nagasa = 0;
    req.on("data", (c) => {
      nagasa += c.length;
      if (nagasa > HONBUN_JOUGEN) { resolve(null); req.destroy(); return; }
      kakera.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(kakera).toString("utf8")));
    req.on("error", reject);
  });
}

async function yomuAtsukai(req, res) {
  if (AIKOTOBA && req.headers["x-aikotoba"] !== AIKOTOBA) {
    return okuruJSON(res, 401, { error: "あいことばが違います。", shu: "aikotoba" });
  }
  if (!kaisuuOk()) {
    return okuruJSON(res, 429, { error: "少し待ってから、もう一度押してください。", shu: "kaisuu", kakera: ["少し待ってから、", "もう一度", "押してください。"] });
  }
  const honbun = await honbunYomu(req);
  if (honbun === null) return okuruJSON(res, 413, { error: "写真が大きすぎます。", shu: "ookisa" });

  let moto;
  try { moto = JSON.parse(honbun); } catch (e) { moto = null; }
  const gazou = moto?.gazou, katachi = moto?.katachi;
  if (typeof gazou !== "string" || !gazou || !BASE64.test(gazou) || !GAZOU_SHURUI.has(katachi)) {
    return okuruJSON(res, 400, { error: "写真の形が読めませんでした。", shu: "katachi" });
  }

  try {
    const kekka = await yomu(gazou, katachi, kagiErabu());
    // 料金の見積もりを実測で確かめるために、使ったトークンの数を書き出す（写真や数は書かない）
    console.log(`[yomu] ${MODEL} 入力 ${kekka.usage.input} / 出力 ${kekka.usage.output} トークン、読めた ${kekka.urenokori.filter(k => k.kazu !== null).length} 品`);
    return okuruJSON(res, 200, { urenokori: kekka.urenokori, usage: kekka.usage });
  } catch (e) {
    // 失敗の種類ごとの日本語は yomu.js の shippaiHenji で決める（上限・鍵違い・混雑・通信・その他）
    const henji = shippaiHenji(e, kagiErabu().namae);
    if (henji.shu === "hoka") console.error("[yomu] 失敗:", e?.status, e?.message);
    else console.log(`[yomu] ${henji.shu}: ${henji.error}`);
    return okuruJSON(res, henji.code, { error: henji.error, shu: henji.shu, kakera: henji.kakera });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://" + (req.headers.host || "localhost"));

  if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }

  if (req.method === "POST" && url.pathname === "/yomu") {
    try { await yomuAtsukai(req, res); }
    catch (e) { console.error("[server] 失敗:", e); okuruJSON(res, 500, { error: "取り次ぎ役の中で失敗しました。", shu: "hoka" }); }
    return;
  }

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return fs.createReadStream(path.join(KOKO, "index.html")).pipe(res);
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("ありません");
});

server.listen(PORT, "0.0.0.0", () => {
  const { namae } = kagiErabu();
  const kagi = namae ? `入っています（${namae}）` : "入っていません（.env の ANTHROPIC_API_KEY= のあとに書くか、環境変数 ANTHROPIC_AUTH_TOKEN を入れてください）";
  console.log(`売れ残り帳の取り次ぎ役を始めました（モデル ${MODEL}）`);
  console.log(`  このパソコンで開く: http://localhost:${PORT}`);
  for (const ifs of Object.values(os.networkInterfaces())) for (const i of ifs) {
    if (i.family === "IPv4" && !i.internal) console.log(`  同じ Wi-Fi のスマホで開く: http://${i.address}:${PORT}`);
  }
  console.log(`  鍵: ${kagi}`);
  console.log(`  あいことば: ${AIKOTOBA ? "あり" : "なし（手元で試すだけなら、このままでよい）"}`);
});
