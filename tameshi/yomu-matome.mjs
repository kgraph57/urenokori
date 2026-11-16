// ───────────────────────────────────────────
// tameshi/yomu-matome.mjs — tameshi/shashin/ の写真を全部 Claude に読ませ、正解（shashin-kotae.json）と比べる。
//
// 動かし方（鍵が要る。作品のフォルダで）:
//   node --env-file-if-exists=.env tameshi/yomu-matome.mjs            全部（52 枚）
//   node --env-file-if-exists=.env tameshi/yomu-matome.mjs p01 u03    名前で選ぶ（p01 なら p01 の 4 枚）
//
// 画面と同じく、写真は長い辺 1568px の JPEG に縮めてから送る（Mac の sips を使う）。
// 1 枚につき Claude を 1 回呼ぶ。失敗しても呼び直さない。
// 結果は tameshi/kekka.json（そのまま）と tameshi/kekka.md（表）に書く。
//
// 欄の数え方（1 枚に 6 欄）:
//   合った         = 正解と同じ数。正解が「読めない」の欄は、「読めない」と答えたとき
//   読めないと答えた = 正解は数なのに「読めない」と答えた（数は入らないので、間違いは起きない）
//   違う数         = 正解は数なのに、違う数を答えた（危ない）
//   読めない欄で数  = 正解は「読めない」なのに、数を答えた（危ない）
//   答えに無かった  = そのお菓子が答えに出てこなかった（数は入らない）
// ───────────────────────────────────────────
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { yomu, MODEL } from "../yomu.js";

const KOKO = path.dirname(fileURLToPath(import.meta.url));
const SHASHIN = path.join(KOKO, "shashin");
const KOTAE = JSON.parse(fs.readFileSync(path.join(KOKO, "shashin-kotae.json"), "utf8"));
const OKASHI = [["mamedaifuku", "豆大福"], ["dorayaki", "どら焼き"], ["kurimanju", "栗まんじゅう"], ["kusamochi", "草餅"], ["monaka", "最中"], ["nerikiri", "練り切り"]];
// Haiku 5.5 の料金（100 万トークンあたり、ドル。2026-11-16 の公式の料金ページ）
const RYOUKIN = { input: 0.10, output: 0.50 };
const EN = 150;   // 1 ドルを何円で換算するか

const apiKey = process.env.ANTHROPIC_API_KEY || "";
const authToken = process.env.ANTHROPIC_AUTH_TOKEN || "";
if (!apiKey && !authToken) { console.error("鍵がありません。.env の ANTHROPIC_API_KEY か、環境変数 ANTHROPIC_AUTH_TOKEN を入れてください。"); process.exit(1); }
const kagi = apiKey ? { apiKey } : { authToken };

const erabi = process.argv.slice(2);
const files = fs.readdirSync(SHASHIN).filter(f => /\.(png|jpe?g)$/i.test(f)).sort()
  .filter(f => !erabi.length || erabi.some(e => f === e || f.startsWith(e + ".") || f.startsWith(e + "-")));
if (!files.length) { console.error("写真が見つかりません:", SHASHIN); process.exit(1); }

// 画面の chijimeru と同じ大きさに縮める
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "urenokori-"));
function chijimeru(file) {
  const out = path.join(tmp, path.basename(file).replace(/\.\w+$/, ".jpg"));
  execFileSync("sips", ["-Z", "1568", "-s", "format", "jpeg", "-s", "formatOptions", "85", path.join(SHASHIN, file), "--out", out], { stdio: "ignore" });
  return fs.readFileSync(out).toString("base64");
}

// 写真の組
function kumiNo(f) {
  if (/^u\d+\./.test(f)) return "kakure";
  if (/-(dim|tilt|rough)\./.test(f)) return "warui";
  return "futsuu";
}
const KUMI_NA = { futsuu: "ふつう（p01〜p12）", warui: "悪い条件（-dim・-tilt・-rough）", kakure: "隠れた（u01〜u04）" };
const RAN = ["atta", "yomenaiKotae", "chigau", "yomenaiRanNiKazu", "nakatta"];
const RAN_NA = { atta: "合った", yomenaiKotae: "読めないと答えた", chigau: "違う数", yomenaiRanNiKazu: "読めない欄で数", nakatta: "答えに無かった" };
const kara = () => ({ mai: 0, zenbuAtta: 0, atta: 0, yomenaiKotae: 0, chigau: 0, yomenaiRanNiKazu: 0, nakatta: 0, shiranai: 0, kinshi: 0, input: 0, output: 0, shippai: 0 });
const kumi = { futsuu: kara(), warui: kara(), kakure: kara(), zenbu: kara() };

const kekka = [];
const gyou = [];
console.log(`写真 ${files.length} 枚を ${MODEL} に送ります。`);
for (const f of files) {
  const key = f.replace(/-(dim|tilt|rough)\.\w+$|\.\w+$/, "");
  const k = kumiNo(f);
  const seikai = KOTAE[key]?.kotae;
  if (!seikai) { console.log(`  ${f}: 正解がありません（shashin-kotae.json に ${key} が無い）`); continue; }
  let r;
  try {
    r = await yomu(chijimeru(f), "image/jpeg", kagi);
  } catch (e) {
    // 失敗でも Claude まで届いていればトークンは使っている（e.usage）。料金の合計に入れる
    const u = e.usage || { input: 0, output: 0 };
    console.log(`  ${f.padEnd(14)} 失敗 ${e.message}  (${u.input}/${u.output})`);
    kekka.push({ file: f, key, kumi: k, shippai: e.message, usage: e.usage });
    gyou.push(`| ${f} | | 失敗：${e.message} | | | ${u.input} / ${u.output} |`);
    for (const g of [kumi[k], kumi.zenbu]) { g.mai++; g.shippai++; g.input += u.input; g.output += u.output; }
    continue;
  }
  const got = Object.fromEntries(r.urenokori.map(u => [u.id, u.kazu]));
  const ran = {};
  const hyou = [];
  const kazoe = { atta: 0, yomenaiKotae: 0, chigau: 0, yomenaiRanNiKazu: 0, nakatta: 0 };
  for (const [id, na] of OKASHI) {
    const e = seikai[id];                       // 正解（数か null）
    const g = id in got ? got[id] : undefined;   // 答え（数か null か、無し）
    let shu;
    if (g === undefined) shu = "nakatta";
    else if (e === null) shu = g === null ? "atta" : "yomenaiRanNiKazu";
    else if (g === null) shu = "yomenaiKotae";
    else shu = g === e ? "atta" : "chigau";
    kazoe[shu]++;
    ran[id] = { seikai: e, kotae: g === undefined ? "無" : g, shu };
    const moji = g === undefined ? "—" : g === null ? "？" : String(g);
    const shirushi = shu === "atta" ? "" : shu === "yomenaiKotae" ? "△" : shu === "nakatta" ? "" : "×";
    hyou.push(`${na} ${moji}${shirushi}`);
  }
  // 写してはいけないものが答えに混ざっていないか
  const zenbuNa = [...r.urenokori.map(u => u.na), ...r.shiranai].join(" ");
  const kinshi = (KOTAE[key].kinshi || []).filter(x => zenbuNa.includes(x));
  const zenbuAtta = kazoe.atta === OKASHI.length;
  for (const g of [kumi[k], kumi.zenbu]) {
    g.mai++; if (zenbuAtta) g.zenbuAtta++;
    for (const s of RAN) g[s] += kazoe[s];
    g.shiranai += r.shiranai.length; g.kinshi += kinshi.length;
    g.input += r.usage.input; g.output += r.usage.output;
  }
  kekka.push({ file: f, key, kumi: k, ran, shiranai: r.shiranai, kinshi, kazoe, zenbuAtta, usage: r.usage, namaKotae: r.urenokori });
  const matome = `合った ${kazoe.atta}` + (kazoe.yomenaiKotae ? `・読めないと答えた ${kazoe.yomenaiKotae}` : "") + (kazoe.chigau ? `・違う数 ${kazoe.chigau}` : "")
    + (kazoe.yomenaiRanNiKazu ? `・読めない欄で数 ${kazoe.yomenaiRanNiKazu}` : "") + (kazoe.nakatta ? `・無かった ${kazoe.nakatta}` : "");
  console.log(`  ${f.padEnd(14)} ${zenbuAtta ? "◎" : "　"} ${matome}  一覧にない: ${r.shiranai.join("、") || "なし"}${kinshi.length ? "  ★写してはいけないもの: " + kinshi.join("、") : ""}  (${r.usage.input}/${r.usage.output})`);
  gyou.push(`| ${f} | ${zenbuAtta ? "◎" : ""} | ${hyou.join("、")} | ${matome} | ${r.shiranai.join("、") || ""}${kinshi.length ? " ★" + kinshi.join("、") : ""} | ${r.usage.input} / ${r.usage.output} |`);
  await new Promise(res => setTimeout(res, 300));
}
fs.rmSync(tmp, { recursive: true, force: true });

const doru = (g) => g.input * RYOUKIN.input / 1e6 + g.output * RYOUKIN.output / 1e6;
const kumiHyou = ["futsuu", "warui", "kakure", "zenbu"].filter(k => kumi[k].mai).map(k => {
  const g = kumi[k];
  const ranSuu = (g.mai - g.shippai) * OKASHI.length;
  return `| ${k === "zenbu" ? "**全部**" : KUMI_NA[k]} | ${g.mai} | ${g.zenbuAtta} | ${g.atta} / ${ranSuu} | ${g.yomenaiKotae} | ${g.chigau} | ${g.yomenaiRanNiKazu} | ${g.nakatta} | ${g.shiranai} | ${g.kinshi} |`;
});
const z = kumi.zenbu;
const md = [
  `# 写真の読み取りの結果（${new Date().toLocaleDateString("ja-JP")}、${MODEL}、長い辺 1568px に縮めて送信）`,
  "",
  "## 組ごとのまとめ",
  "",
  "| 組 | 枚数 | 6 欄とも合った枚数 | 合った欄 / 欄の数 | 読めないと答えた | 違う数 | 読めない欄で数 | 答えに無かった | 一覧にない名前 | 写してはいけないもの |",
  "|---|---|---|---|---|---|---|---|---|---|",
  ...kumiHyou,
  "",
  `- 「合った」は、正解と同じ数のときだけ。正解が「読めない」の欄は、「読めない」と答えたときだけ。`,
  `- 「違う数」と「読めない欄で数」は、間違った数が表に入る、危ない欄。「読めないと答えた」と「答えに無かった」は、数が入らないので危なくはない。`,
  z.shippai ? `- 失敗して読めなかった写真：${z.shippai} 枚（欄の数に入れていない）。` : "",
  "",
  "## 1 回測るのにかかった分",
  "",
  `- トークン：入力 ${z.input.toLocaleString()}、出力 ${z.output.toLocaleString()}（1 枚あたり 入力 ${Math.round(z.input / Math.max(1, z.mai - z.shippai))}、出力 ${Math.round(z.output / Math.max(1, z.mai - z.shippai))}）。`,
  `- 料金：約 ${doru(z).toFixed(4)} ドル（1 ドル ${EN} 円で約 ${(doru(z) * EN).toFixed(1)} 円）。1 枚あたり約 ${(doru(z) / Math.max(1, z.mai - z.shippai) * EN).toFixed(2)} 円。入力 100 万トークン ${RYOUKIN.input} ドル・出力 100 万トークン ${RYOUKIN.output} ドルで計算。`,
  "",
  "## 写真ごと",
  "",
  "印：◎ は 6 欄とも合った。数のあとの × は違う数（または読めない欄で数）、△ は読めないと答えた、？ は「読めない」の答え、— は答えに無かった。",
  "",
  "| 写真 | | 読んだ数 | まとめ | 一覧にない名前 | 入力 / 出力 |",
  "|---|---|---|---|---|---|",
  ...gyou,
  "",
].filter(s => s !== null).join("\n");
fs.writeFileSync(path.join(KOKO, "kekka.json"), JSON.stringify({ hi: new Date().toISOString(), model: MODEL, kumi, kekka }, null, 1));
fs.writeFileSync(path.join(KOKO, "kekka.md"), md);
console.log("\n" + md.split("\n## 写真ごと")[0]);
console.log(`書きました: tameshi/kekka.md, tameshi/kekka.json`);
