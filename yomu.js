// ───────────────────────────────────────────
// yomu.js — ノートの写真を Claude に送り、お菓子の名前と売れ残りの数を読んでもらう中身。
//
// ここには「Claude にどう頼むか」だけを書く。どこで動かすか（この Mac か、インターネットか）は
// 入口のファイル（server.js など）が決めるので、このファイルは置く場所が変わっても使い回せる。
// 鍵（API キー）は入口から受け取る。ここには書かない。
// ───────────────────────────────────────────
import Anthropic from "@anthropic-ai/sdk";

export const MODEL = "claude-haiku-5-5";

// システムプロンプトに出てくる 6 つの名前と、index.html の OKASHI の id の対応
export const OKASHI_NA = {
  "豆大福": "mamedaifuku",
  "どら焼き": "dorayaki",
  "栗まんじゅう": "kurimanju",
  "草餅": "kusamochi",
  "最中": "monaka",
  "練り切り（季節）": "nerikiri",
};

// Claude への頼み方（システムプロンプト）。この文はそのまま使う決まりなので、ここを直すときは相談する。
export const SYSTEM = `あなたは、和菓子の店のノートの写真から、売れ残りの数を読み取る係です。

・読むのは、お菓子の名前と、その横に書かれた売れ残りの数だけです。
・お菓子の名前は、次の6つのどれかです：豆大福、どら焼き、栗まんじゅう、草餅、最中、練り切り（季節）。
・数が読めない、または自信がないときは、推測せず、「読めない」としてください。
・写真に、お菓子の売れ残り以外のこと（人の名前、電話番号、お金の額など）が写っていても、書き写さないでください。
・答えは、お菓子の名前と数の組だけを返してください。説明の文は要りません。`;

// 答えの決まった形。この形に合う JSON だけが返ってくる。
//   na   = 6 つの名前のどれか
//   kazu = 売れ残りの数（0 以上の整数）。「読めない」は null
const KATACHI = {
  type: "json_schema",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["urenokori"],
    properties: {
      urenokori: {
        type: "array",
        description: "写真に書かれていた、お菓子の名前と売れ残りの数の組。写真に無いお菓子は入れない",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["na", "kazu"],
          properties: {
            na: { type: "string", enum: Object.keys(OKASHI_NA) },
            kazu: { type: ["integer", "null"], description: "売れ残りの数。「読めない」ときは null" },
          },
        },
      },
    },
  },
};

// 読み取りがうまくいかなかったときの印。shu（種類）で入口が返事を分ける
export class YomuError extends Error {
  constructor(shu, message) { super(message); this.shu = shu; }
}

// 写真 1 枚を Claude に 1 回だけ送る。
//   gazou     = 写真の base64（JPEG など）
//   katachi   = "image/jpeg" のような種類
//   apiKey    = 鍵。入口が環境変数 ANTHROPIC_API_KEY から読んで渡す
//   authToken = 鍵の代わりのしるし。入口が環境変数 ANTHROPIC_AUTH_TOKEN から読んで渡す
//               （部品はどちらか 1 つしか受け取らない。両方あれば apiKey を使う）
// 返り値: { urenokori: [{ id, na, kazu }], usage: { input, output } }
export async function yomu(gazou, katachi, { apiKey, authToken } = {}) {
  if (!apiKey && !authToken) throw new YomuError("kagi", "鍵（ANTHROPIC_API_KEY か ANTHROPIC_AUTH_TOKEN）が入っていません。");

  const client = new Anthropic(apiKey ? { apiKey } : { authToken });
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,                      // 答えは数十トークン。考える分の余裕を見てこの数
    system: SYSTEM,
    output_config: { effort: "medium", format: KATACHI },
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: katachi, data: gazou } },
        { type: "text", text: "このノートの写真を読んでください。" },
      ],
    }],
  });

  const usage = { input: res.usage.input_tokens, output: res.usage.output_tokens };

  // 読む前に、途中で止まっていないかを見る
  if (res.stop_reason === "refusal") throw new YomuError("kotowari", "Claude がこの写真の読み取りを断りました。別の写真で試してください。");
  if (res.stop_reason === "max_tokens") throw new YomuError("tochuu", "答えが途中で切れました。もう一度試してください。");

  // 答えの文は type が "text" のブロック（先に考えのブロックが来ることがある）
  const text = res.content.find(b => b.type === "text")?.text;
  let kotae;
  try { kotae = JSON.parse(text); } catch (e) { kotae = null; }
  if (!kotae || !Array.isArray(kotae.urenokori)) throw new YomuError("katachi", "答えの形が読めませんでした。もう一度試してください。");

  // 6 つの名前に合うものだけ、1 つの名前につき 1 つ（同じ名前が 2 回あれば先のもの）
  const mita = new Set();
  const urenokori = [];
  for (const k of kotae.urenokori) {
    const id = OKASHI_NA[k?.na];
    if (!id || mita.has(id)) continue;
    mita.add(id);
    const kazu = (Number.isInteger(k.kazu) && k.kazu >= 0) ? k.kazu : null;
    urenokori.push({ id, na: k.na, kazu });
  }
  return { urenokori, usage };
}
