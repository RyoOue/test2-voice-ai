import express, { Request, Response } from "express";
import bodyParser from "body-parser";           // ← 署名検証のため raw 受信
import WebSocket from "ws";
import dotenv from "dotenv";

// ====== 環境変数 ======
dotenv.config();
const PORT = Number(process.env.PORT || 8000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const WEBHOOK_SECRET = process.env.OPENAI_WEBHOOK_SECRET; // 実装は後述の簡易スタブ
const DEFAULT_VOICE = process.env.DEFAULT_VOICE || "marin";
const REALTIME_MODEL = process.env.REALTIME_MODEL || "gpt-realtime";

// 必須チェック
if (!OPENAI_API_KEY) {
  console.error("ERROR: OPENAI_API_KEY が未設定です。");
  process.exit(1);
}
if (!WEBHOOK_SECRET) {
  console.warn("Warning: OPENAI_WEBHOOK_SECRET が未設定のため、署名検証をスキップします（開発用途）。");
}

const app = express();

// ⚠️ Webhook 署名検証を壊さないため raw で受ける
app.use(bodyParser.raw({ type: "*/*" }));

// === 会話シナリオ（instructions）
// MVP段階では直書きでOK（後でReusable Prompts等へ切り出し）
function getCallInstructions(): string {
  return `あなたは人材会社の「採用説明会の出欠確認」専任の電話AIエージェントです。日本語で、簡潔・明瞭・ていねいに応対します。目的は、候補者の出欠を確定し、必要に応じて日程変更やフォロー連絡（SMS/メール）まで完了することです。

## 話し方・態度
- トーン：落ち着いて明るい/ビジネス丁寧/早口すぎない。相手が急いでいればテンポを上げる。
- 被せられても聞き直せる。相手が黙ったら約2秒待って、要点質問に戻る。
- 結論→要点→次の行動の順で短く案内する。

## 開始（発信/着信で文言を切替）
- 発信時： 「お電話失礼いたします。◯◯社の採用事務局です。◯月◯日◯時 開催の“◯◯職 説明会”について、【出欠のご確認】でおかけしました。◯◯（候補者氏名）さまでお間違いないでしょうか？」
- 着信時： 「お電話ありがとうございます。◯◯社の採用事務局です。◯月◯日◯時開催“◯◯職 説明会”の【出欠のご用件】でしょうか？」

## 取得する必須情報（順不同でも可。自然に聞き切る）
1) 氏名（カタカナも） 2) 連絡先（折返し番号） 3) 対象イベント（タイトル/日付/時刻/会場orURL）  
4) 出欠ステータス（出席 / 欠席 / 迷い中） 5) 変更希望（ある場合：第1〜第3希望）  
6) 連絡手段の希望（SMS/メール） 7) 配慮事項（遅刻・同伴・特記事項があれば）

## 判断と分岐
- 出席：その場で「出席」に確定 → 会場/URL・持ち物・開始10分前の案内を“短く”復唱 → SMS/メール送付を提案。
- 欠席：理由を一言で伺い、代替回を2候補提示（なければ最短候補1～2件）。希望が無ければ「辞退」で登録。
- 迷い中：締切（◯/◯ ◯:◯◯）を伝え、仮押さえ or 追って連絡のいずれかを選んでもらう。

## 厳守ルール
- 重要事項は必ず復唱確認（日時/会場/URL/オンラインIDなど）。
- 不明確な点は推測しない。「確認のうえ折り返します」と案内。
- 個人情報は最小限の読み上げに留め、保存はツールで行う。
- 説明会の内容や評価に関する推測・確約はしない（評価や合否時期は定型の社内文面のみ）。

## ツール（関数）呼び出し（存在すると仮定して自然に使う）
- check_slots({ event_id?, role?, dates[] }): 代替回の空き照会。返り値例 "9/12 19:00 有"。
- update_attendance({ candidate_name, phone, event_id, status, reason?, memo? }): 出欠ステータスを更新。
- send_message({ to, via, body }): SMS/メール送信（会場URLや持ち物、確定通知）。
- save_lead({ name, kana?, phone, email?, note }): 連絡先・会話要約を保存。

## 例：出席確定の最終確認（短文化）
「◯◯さま、◯月◯日（◯）◯時開始“◯◯職 説明会”に【出席】で承りました。会場は◯◯ビル3F、開始10分前にお越しください。詳細をSMSでお送りします。よろしいでしょうか？」

## 通話終了
- 要約→確認→お礼。「本日はありがとうございます。当日お待ちしております。」`;
}

// `/accept` に投げるペイロード（SIP/8kHz に寄せた設定を含む）
function buildAcceptPayload(instructions: string, voice: string) {
  return {
    model: REALTIME_MODEL,
    response: {
      modalities: ["audio"],
      instructions,
      // 通話向け: μ-law 8kHz を明示
      audio: { voice, format: "pcm_mulaw", sample_rate: 8000 }
    }
  };
}

// 同一 call_id の重複 /accept を抑止（Webhook 再送対策）
const acceptedCalls = new Set<string>();

// WebSocket：Realtime セッション管理（将来のツール呼び出しに備えた雛形）
async function handleCallWebSocket(callId: string) {
  const wsUrl = `wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}`;
  const ws = new WebSocket(wsUrl, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      Origin: "https://api.openai.com" // 必須ヘッダ
    }
  });
  let sentGreeting = false;

  ws.on("open", () => {
    console.log(`WebSocket open: call ${callId}`);
    // セーフティ: session.created が来ない場合のフォールバック送信（1秒後）
    setTimeout(() => {
      if (sentGreeting) return;
      const greeting = "お電話ありがとうございます。◯◯社の採用事務局です。◯月◯日◯時開催“◯◯職 説明会”の【出欠のご用件】でしょうか？";
      ws.send(
        JSON.stringify({
          type: "response.create",
          response: { instructions: greeting },
        })
      );
      console.log("Sent greeting (fallback timer)");
      sentGreeting = true;
    }, 1000);
  });

  ws.on("message", (data) => {
    try {
      const evt = JSON.parse(typeof data === "string" ? data : data.toString("utf8"));
      // 代表的なイベントを簡易ログ
      if (evt.type === "session.created") {
        // セッション確立後に初期発話を送る（タイミング問題を回避）
        const greeting = "お電話ありがとうございます。◯◯社の採用事務局です。◯月◯日◯時開催“◯◯職 説明会”の【出欠のご用件】でしょうか？";
        ws.send(
          JSON.stringify({
            type: "response.create",
            response: { instructions: greeting },
          })
        );
        console.log("Sent greeting after session.created");
        sentGreeting = true;
      } else if (evt.type === "response.done") {
        console.log("Assistant response done.");
      } else if (evt.type?.startsWith?.("response.output_audio.")) {
        console.log("Audio event:", evt.type);
      } else if (evt.type?.startsWith?.("response.output_text.")) {
        console.log("Text event:", evt.type);
      } else if (evt.type && String(evt.type).startsWith("conversation.tool")) {
        console.log("Tool call (placeholder):", evt);
        // 将来：ここで実関数を実行し、結果をモデルに返す
      } else if (evt.type) {
        if (evt.type === "error") {
          console.error("WS error event:", JSON.stringify(evt, null, 2));
        } else {
          console.log("WS event:", evt.type);
        }
      }
    } catch {
      console.log("WS message:", (data as Buffer).toString("utf8").slice(0, 160), "...");
    }
  });

  ws.on("error", (err) => console.error("WebSocket error:", err));
  ws.on("close", (code, reason) => console.log(`WebSocket close: ${code} ${reason || ""}`));
}

// 簡易署名検証スタブ（本番は必ず正規の手順で検証）
function verifyOpenAIWebhook(rawBody: string, headers: Record<string, string>, secret?: string): boolean {
  if (!secret) return true; // 未設定ならスキップ（開発向け）
  // TODO: OpenAI の最新ドキュメントに従い、署名ヘッダを検証する実装を追加
  // ここでは MVP のため true を返す
  return true;
}

// Webhook エンドポイント
app.post("/openai-webhook", async (req: Request, res: Response) => {
  const raw = req.body.toString("utf8");

  // 1) 署名検証（本番では必須）
  const ok = verifyOpenAIWebhook(raw, req.headers as Record<string, string>, WEBHOOK_SECRET);
  if (!ok) {
    console.error("Invalid webhook signature.");
    return res.status(400).send("Invalid signature");
  }

  // 2) イベントパース
  let event: any;
  try {
    event = JSON.parse(raw);
  } catch (e) {
    console.error("Webhook parse error:", e);
    return res.status(400).send("Bad request");
  }

  // 3) 受電イベント
  if (event.type === "realtime.call.incoming") {
    const callId = event.data?.call_id;
    console.log(`Incoming call: call_id=${callId}`);

    // /accept を “即時” 実行（無音対策）
    try {
      if (!callId || acceptedCalls.has(callId)) {
        if (!callId) console.warn("Webhook missing call_id");
        else console.log(`Skip duplicate accept for call_id=${callId}`);
        return res.sendStatus(200);
      }
      const acceptUrl = `https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/accept`;
      const acceptPayload = buildAcceptPayload(getCallInstructions(), DEFAULT_VOICE);
      const resp = await fetch(acceptUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(acceptPayload)
      });
      if (!resp.ok) {
        const t = await resp.text().catch(() => "");
        console.error("Call accept failed:", resp.status, resp.statusText, t);
        return res.status(502).send("Failed to accept call");
      }

      console.log("Accepted. Connecting Realtime WebSocket…");
      acceptedCalls.add(callId);
      // 非同期でWS接続（待たない）
      handleCallWebSocket(callId).catch(e => console.error("WS task error:", e));
    } catch (e) {
      console.error("Call accept error:", e);
      return res.status(500).send("Call accept error");
    }
  }

  // 4) ACK を返す（重要）
  res.set("Authorization", `Bearer ${OPENAI_API_KEY}`); // 必要に応じて
  return res.sendStatus(200);
});

app.listen(PORT, () => {
  console.log(`Server listening: http://localhost:${PORT}`);
  console.log(`Realtime model: ${REALTIME_MODEL}, voice: ${DEFAULT_VOICE}`);
});
