# OpenAI Voice Call Agent (MVP) — 採用説明会の出欠確認

**Node.js + TypeScript + Express** と **OpenAI Realtime API** を用いた、電話での「出欠確認」AIエージェントの最小実装です。
受電Webhook（`realtime.call.incoming`）を受け、即時 `/accept` → Realtime の WebSocket を開き、会話を開始します。

## 特徴
- **gpt-realtime** モデル ＆ **Marin** ボイス（日本語）で自然な音声対話
- 会話シナリオは **instructions に直書き**（後で Reusable Prompts へ切り出し可能）
- WebSocket 雛形：将来の **ツール呼び出し**（空き照会/出欠更新/SMS送信 等）に対応しやすい構成
- PSTNからの着信は、SIPトランク（例：Twilio Elastic SIP Trunk）→ OpenAI SIP → 本Webhook という経路を想定

## 前提
- Node.js v18+（推奨：LTS）
- OpenAI の **Realtime API** にアクセスできる API Key
- ローカル開発時の公開URL（ngrok など）
- （PSTNが必要な場合）SIPトランク（例：Twilio）と電話番号

## セットアップ
```bash
npm i
cp .env.example .env  # 値を設定
npm run dev           # 開発（ホットリロード）
# or
npm run build && npm start
```

## 環境変数
- OPENAI_API_KEY（必須）: OpenAI Realtime API 用のトークン。
- OPENAI_WEBHOOK_SECRET（任意/本番必須）: OpenAI Webhook 検証用の `whsec_...`。未設定時は検証スキップ。
- PORT（任意）: デフォルト `8000`。
- DEFAULT_VOICE（任意）: デフォルト音声。日本語は `marin` 推奨。

## アーキテクチャ概要
- PSTN（電話） → Twilio Elastic SIP Trunk → `sip:<PROJECT_ID>@sip.api.openai.com`（OpenAI SIP）
- OpenAI 側で着信イベント → Webhook（本サーバ `/openai-webhook`）へ `realtime.call.incoming` を POST
- サーバは即時 `/accept` を POST → OpenAI が音声セッションを開始
- サーバは Realtime WebSocket に接続して、初期発話とツール呼び出し受付を行う

## OpenAI Webhook 設定（`realtime.call.incoming`）
1. OpenAI コンソールで Webhook を作成（または編集）
   - イベント: `realtime.call.incoming`
   - エンドポイントURL: `https://<あなたの公開URL>/openai-webhook`
   - シークレット: 自動発行された `whsec_...` を控える → `.env` の `OPENAI_WEBHOOK_SECRET` に設定
2. 保存後、着信時に本サーバへ生ボディ（raw）が POST されます。
3. 本実装はボディを raw で受け取り、即時 `/accept` を実行 → Realtime WS に接続します。

ローカル開発例（ngrok）
```bash
ngrok http 8000
# 例: https://abcd-12-34-56-78.ngrok-free.app を Webhook URL に設定
```

## Twilio Elastic SIP Trunk 設定（例）
Twilio を PSTN入り口として利用し、着信を OpenAI SIP へ転送する想定です。

1. Twilio Console → Elastic SIP Trunking → Create new Trunk
2. Origination（Twilio → 宛先）に以下の URI を追加
   - `sip:<PROJECT_ID>@sip.api.openai.com;transport=tls`
   - `<PROJECT_ID>` は OpenAI 側のプロジェクトIDに置換
3. 必要に応じて TLS を有効化、コーデックや地域を選択
4. Twilio の電話番号の Voice 設定で、この Trunk に着信をルーティング

注意:
- OpenAI SIP には TLS（`transport=tls`）が必要です。
- Twilio 側で Trunk と番号の紐付けができていないと着信が流れません。
- OpenAI 側のプロジェクト／権限設定も確認してください。

## 動作確認手順
1. サーバ起動: `npm run dev`
2. ログ確認: `Server listening: http://localhost:8000`
3. Webhook を公開URLに向ける（ngrok 等）
4. PSTN から Twilio番号へ発信
5. 期待ログ:
   - `Incoming call: call_id=...`
   - `Accepted. Connecting Realtime WebSocket…`
   - `WebSocket open: call ...`
   - `Assistant response done.`（モデル側の初期応答完了）

## よくある落とし穴（必読）
- raw ボディ必須: 署名検証のため、`express.json()` ではなく `body-parser.raw()` を使用（本実装済み）。
- `/accept` は即時: 無音/取りこぼし回避のため、Webhook 受信後すぐに `POST /v1/realtime/calls/{callId}/accept` を実行。
- 200 を早く返す: Webhook ハンドラの最後で `200` を速やかに返す（本実装済み）。
- Realtime WS の `Origin` ヘッダ: `Origin: https://api.openai.com` が必須（本実装済み）。
- `wss://` を使用: `ws://` ではなく `wss://api.openai.com/v1/realtime?call_id=...` に接続（本実装済み）。
- APIキー漏えいに注意: サーバ側でのみ使用。フロントには埋め込まない。
- Node 18+ 推奨: `fetch` 利用のため。古い Node では `fetch` 未定義エラーになります。
- ngrok の再起動で URL が変わる: Webhook URL を毎回更新。

## 署名検証について（次ステップ推奨）
- 本実装は `OPENAI_WEBHOOK_SECRET` 未設定時に検証スキップ（開発用）。
- 本番運用では OpenAI 公式の手順に従い、ヘッダ（例: `svix-id` / `svix-timestamp` / `svix-signature`）を `whsec_...` で検証してください。
- 実装方針例: `body-parser.raw()` のバイト列をそのまま検証 → OK のみ処理継続。

## 実装ポイント（コード要約）
- 受電Webhook: `POST /openai-webhook`（raw 受信）
- イベント `realtime.call.incoming` を受信 → `call_id` 抽出 → `/accept` を即時 POST
- `/accept` には以下のボディ（抜粋）を送信
  ```json
  {
    "model": "gpt-realtime",
    "response": {
      "modalities": ["audio"],
      "instructions": "...（日本語シナリオ直書き）...",
      "audio": { "voice": "marin" }
    }
  }
  ```
- 受理後、`wss://api.openai.com/v1/realtime?call_id=...` に接続し、`response.create` で初期発話を送信。
- `response.done` や 将来のツール呼び出しイベントをログ出力。

## スクリプト
- `npm run dev`: `tsx watch` で開発
- `npm run build`: TypeScript ビルド（`dist/`）
- `npm start`: `node dist/index.js`

## トラブルシューティング
- 401/403（/accept 失敗）: `OPENAI_API_KEY` を確認。権限・モデルアクセス権があるか確認。
- 502/エラー（/accept 失敗）: ボディの JSON 形式・ヘッダ（`Authorization`, `Content-Type`）を確認。
- WebSocket が即時 Close: `Origin` ヘッダや `call_id` の有効性、/accept が成功しているかを確認。
- イベントが届かない: Webhook URL の公開性/TLS、ngrok URL の有効性、OpenAI コンソール設定を再確認。

## 次の拡張例
- 署名検証の本実装（必須化）
- ツール呼び出しの接続（`check_slots` / `update_attendance` / `send_message` / `save_lead`）
- 会話ログ/監査ログの保存、モニタリング追加
- 失敗時の自動リトライやバックオフ

