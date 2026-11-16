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

// 利用額の上限に届いたときの返事か（Anthropic の公式資料の 2 種類）
//   ・自分で Console に決めた上限 → 400。文が「You have reached your specified … API usage limits」で始まる
//   ・使用段階ごとの月の上限     → 429。印 error_code が enforced_spend_limit_reached
export function jougenKa(e) {
  const bun = e?.apiMessage || "";
  if (e instanceof Anthropic.BadRequestError && /^You have reached your specified (workspace )?API usage limits/.test(bun)) return true;
  if (e instanceof Anthropic.RateLimitError && (e.errorCode === "enforced_spend_limit_reached" || /^You have reached your API usage limits/.test(bun))) return true;
  return false;
}

// 読み取りの失敗を、画面に出す日本語と、取り次ぎ役が返す番号に直す。
//   kagiNamae = 使っている鍵の環境変数の名前（鍵違いの文に出す）
// 返り値: { code, error, shu, kakera }
//   kakera = 画面で折り返してよい切れ目ごとに分けた文（写真の枠が狭いとき、言葉の途中で折れないように）
export function shippaiHenji(e, kagiNamae = "") {
  const henji = (code, shu, ...kakera) => ({ code, shu, kakera, error: kakera.join("") });
  if (e instanceof YomuError) return henji(e.shu === "kagi" ? 500 : 502, e.shu, e.message);
  if (jougenKa(e)) return henji(503, "jougen", "今月の", "読み取りの上限に", "届きました。", "数は", "手で", "入れてください。");
  if (e instanceof Anthropic.AuthenticationError) return henji(500, "kagi", `鍵（${kagiNamae}）が`, "正しくありません。");
  if (e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError) {
    return henji(502, "konzatsu", "Claude が", "混んでいます。", "少し待ってから、", "もう一度", "押してください。");
  }
  if (e instanceof Anthropic.APIConnectionError) return henji(502, "tsuushin", "Claude に", "つながりません。", "インターネットを", "確かめてください。");
  return henji(502, "hoka", "読み取りに", "失敗しました。", "もう一度", "試してください。");
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

  // maxRetries: 0 = 失敗しても部品が勝手に呼び直さない（既定は 2 回まで呼び直す）。
  // 1 回押したら Claude を呼ぶのは 1 回だけにして、押し直すかどうかは人が決める。
  const client = new Anthropic({ ...(apiKey ? { apiKey } : { authToken }), maxRetries: 0 });
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
