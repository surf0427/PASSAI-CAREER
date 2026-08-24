# GD 完全音声型 — current state（STEP-GD-VOICE）

> GD（ソロ / マルチ / フレンド / ランダムマッチ）を **本番仕様として完全音声型**にした STEP。
> 既存の room 設計（Supabase server 正本 / API ゲートウェイ / seq 採番 / 冪等 / host 認可 /
> Realtime / heartbeat / server timer / 評価）は**温存**し、発言の *取得手段* と *出力手段* だけを
> テキストから音声へ差し替えた。作り直しは行っていない。

## 1. 確定仕様

- **GD 中にユーザーが文字を入力する場所は存在しない**（textarea / input / contentEditable いずれも無い）。
- ユーザーの発言は **マイク音声からのみ**取得する。
- GD 中の操作は「マイクを有効にする」（初回 1 回）と「ミュート」だけ。
  発言の開始・終了は**話すだけで自動確定**する（押して話すボタンも無い）。
- AI 参加者の発言・進行アナウンスは**音声で再生**する。
- マルチ / フレンド / ランダムマッチでは**参加者同士の実音声**が聞こえる（WebRTC）。
- 文字起こしは評価と記録のために保持・表示するが、**ユーザーが編集・送信する入力欄にはしない**。
- 開始から終了・評価まで **キーボード入力を必要としない**。

## 2. 採用した方式と、その理由

| 領域 | 方式 | 理由 |
|---|---|---|
| STT（発言取得） | MediaRecorder → `POST /api/career/gd/voice/stt` → OpenAI Whisper | Safari / iOS を含む全ブラウザで同一挙動。Web Speech API は Firefox 非対応・iOS Safari で連続認識が不安定で、長時間の GD に耐えない |
| 発話区切り | 音量（RMS）ベースの VAD（`lib/careerGd/voiceSegmenter.ts`） | 「押して話す」を不要にする。GD 中の操作をゼロに保つのが要件 |
| TTS（AI 音声） | `POST /api/career/gd/voice/tts` → OpenAI TTS、失敗時は `speechSynthesis` へ降格 | AI の発言が無音になると GD が成立しない。声質が落ちても必ず耳に届ける |
| 参加者間音声 | WebRTC mesh + Supabase Realtime broadcast シグナリング | 新規ベンダー契約なしで成立する。想定人数 4 / 6 / 8 人・音声のみなら mesh で足りる（8 人 = 各自 7 本） |

## 3. 各モードの発言経路（変更後）

### ソロプレイ

```text
マイク音声（常時録音）
→ VAD が発話の切れ目を判定（voiceSegmenter）→ MediaRecorder を stop/start して 1 クリップ
→ POST /api/career/gd/voice/stt（Whisper・保存しない・課金しない）
→ client state: GdUtterance{kind:'speech'} を transcript へ push
→ transcript: localStorage 'careerGdSessions'（従来どおり canonical）
→ discussion log: 同一配列を「文字起こし」として表示（編集不可）
→ AI 応答: POST /api/career/gd/turn → 返ってきた発言を TTS で再生（solo:<index> の声）
→ evaluation: POST /api/career/gd/feedback（従来どおり・Daily Quota 消費点はここだけ）
→ persistence: localStorage 'careerGdResults' + Supabase mirror + recordCareerEvent（従来どおり）
```

### マルチ / フレンド / ランダムマッチ（3 モード共通・同一画面）

```text
マイク音声（常時録音）
├─ WebRTC mesh → 他参加者へ**実音声**を直接配信（Supabase broadcast でシグナリング）
└─ VAD が切れ目を判定 → 1 クリップ
   → POST /api/career/gd/voice/stt
   → client state: useCareerGdMessages.sendMessage(transcript)  ← **従来と同一**
   → API: POST /api/career/gd/room/[roomId]/messages            ← **従来と同一**
          （kill switch → 認証 → rate limit → 参加者検証 → 期限検証 → seq 採番 RPC）
   → realtime: postgres_changes INSERT 購読 + fallback poll     ← **従来と同一**
   → transcript: career_gd_room_messages（server 正本）          ← **従来と同一**
   → discussion log: seq 昇順で「文字起こし」として表示（編集不可）
   → AI 発言: POST /room/[roomId]/ai-turn → messages へ INSERT → 受信側が persona 別の声で再生
   → evaluation: POST /room/[roomId]/result                     ← **従来と同一**
   → persistence: career_gd_room_results + localStorage 'careerGdRoomLogs' ← **従来と同一**
```

★ **保存経路・採点契約・DDL は一切変えていない**。音声はテキストの取得手段を差し替えただけで、
`career_gd_room_messages` に列は増えていない（＝**DDL の追加適用は不要**）。

## 4. 追加したもの

| # | 追加 | ファイル |
|---|---|---|
| 1 | 音声の共有プリミティブ（mime 選択 / 文字起こし採否 / persona 別の声 / ICE 解析 / glare 回避） | `lib/careerGd/voice.ts` |
| 2 | 発話区切りの状態機械（純関数・QA 可能） | `lib/careerGd/voiceSegmenter.ts` |
| 3 | WebRTC mesh とシグナリング | `lib/careerGd/voiceMesh.ts` / `hooks/useCareerGdVoiceMesh.ts` |
| 4 | マイク所有者 / 文字起こし / 読み上げ / 事前照会 の 4 Hook | `hooks/useCareerGdMic.ts` ほか |
| 5 | 音声 API 3 本（stt / tts / capabilities） | `app/api/career/gd/voice/**` |
| 6 | 音声コントロール UI（旧 textarea の置き換え） | `app/career/gd/components/voice/GdVoiceBar.tsx` |
| 7 | server 側の可用性判定 | `lib/careerGd/voice.server.ts` |
| 8 | 音声 QA（150 checks） | `scripts/gd-qa/voice.qa.ts`（`npm run qa:careerGdVoice`） |

`lib/interviewAi/tts.ts` には `voice` / `speed` / `instructions` の明示指定口を**非破壊で**追加した
（未指定なら従来と完全に同一の挙動。面接の既存呼び出しは影響を受けない）。

## 5. 本番通電の手順（運用者向け）

### 5-1. DDL

**不要**。列も表も増えていない（`career_gd_multi_apply.sql` / `career_gd_realtime_apply.sql` のまま）。

### 5-2. env

| env | 値 | 必須 | 未設定時 |
|---|---|---|---|
| `INTERVIEW_AI_STT_PROVIDER` | `openai` | **必須** | 文字起こし不可 → **GD を開始させない**（開始ボタンが押せず理由を表示） |
| `OPENAI_API_KEY` | OpenAI の key | **必須** | 同上 |
| `INTERVIEW_AI_TTS_PROVIDER` | `openai` | 推奨 | AI の声がブラウザ合成に降格（GD は成立するが声質が落ちる） |
| `NEXT_PUBLIC_CAREER_GD_ICE_SERVERS` | TURN の JSON 配列 | **推奨** | 公開 STUN のみ。**対称 NAT 配下の参加者と P2P が張れない**（下記 §7） |

★ 音声専用の kill switch は**意図的に作っていない**。GD は音声でしか進行できないため
「GD は ON だが音声だけ OFF」は縮退ではなく壊れた商品状態であり、運用上その状態を作れてはいけない。
停止したいときは従来どおり `CAREER_GD_ENABLED` を落とす（GD ごと止まる）。

### 5-3. 通電確認

```bash
npm run qa:careerGdVoice      # 音声契約（純関数の境界 + 構造検査）
npm run qa:careerGd           # GD product 仕様（voice QA を含む）
npm run qa:careerGdProduction # 本番運用条件（flag / RLS / 切断 / timer）
```

## 6. 課金の位置（変更なし）

- `/voice/stt` … `recordUsage` を呼ばない / Daily Quota を消費しない。**有料ゲートは通す**
  （未契約者に Whisper コストを発生させない）。無音クリップは送信前に破棄するので課金されない。
- `/voice/tts` … 同上。
- **GD の Quota 消費点は従来どおり評価（`/feedback` / `/result`）のみ**。
  音声化で「1 回の GD の消費量」は変わっていない。

## 7. 既知の限界（正直に記す）

1. **TURN 未設定だと一部の参加者と音声が繋がらない。**
   公開 STUN のみでは対称 NAT（一部のモバイル回線・企業 NW）配下で P2P を確立できない。
   その相手の声だけが聞こえない状態になる。
   → 無言にはしない。`GdVoiceBar` が「◯◯さんと音声がつながりませんでした」と表示し、
   発言内容は文字起こしで共有され続ける。本番で取りこぼしを消すには TURN を設定すること。
2. **人数の上限は mesh の性質で決まる。** 現行の想定（4 / 6 / 8 人）は問題ないが、
   これを大きく超える人数を扱うなら SFU への移行が必要になる。
3. **背景タブでは VAD の精度が落ちる。** ブラウザが `setInterval` を 1 秒へ丸めるため、
   発話終了の判定が最大 1 秒遅れる（発言は失われない）。
4. **E2E は「マイク音声 → 発言」を検証していない。**
   実マイクの発話は CI で再現できず、Whisper の実課金も伴う。E2E は発言を messages API へ
   直接投入する（`tests/e2e/helpers.ts` の `speakAs`）ことで、seq / 冪等 / Realtime 配信 /
   二重表示防止 / 権限 / timer / 結果生成という**発言が入った後の契約**を従来どおり検証する。
   加えて `expectVoiceOnlyComposer` で「文字入力欄が無いこと」を各 spec が確認する。

## 8. 実機で確認すること（コード検査では代替できない）

QA が全部 PASS しても、以下は実機でしか証明できない。

| # | 確認 | 期待 |
|---|---|---|
| 1 | iOS Safari で「マイクを有効にする」→ 話す | 文字起こしがログに出る。**AI の声も鳴る**（AudioContext の解除が効いている証拠） |
| 2 | iOS Safari でマイクを一度「許可しない」にする | 復帰手順（「ぁあ」→ Webサイトの設定）の文言が出る。無反応にならない |
| 3 | macOS Safari で録音 | `audio/mp4` が選ばれて文字起こしが通る（webm 決め打ちでない証拠） |
| 4 | 2 端末（別ネットワーク）でフレンドマッチ | 互いの**生の声**が聞こえる。`参加者の音声: n / m 人と接続中` が満たされる |
| 5 | 片方をモバイル回線にする | 繋がらない場合に失敗が**表示される**（無言で音が来ない状態にならない） |
| 6 | ミュート → 解除 | 解除後に再プロンプトが出ず、そのまま発言できる（`track.enabled` 方式の証拠） |
| 7 | 発話中に 0.5 秒ほど間を置く | 発言が分断されず 1 発言として記録される |
| 8 | 話し終えて 1.2 秒黙る | その時点で発言が確定し、ログに現れる |
| 9 | ソロで GD を開始 | AI が先に口火を切り、その声が聞こえる |
| 10 | `INTERVIEW_AI_TTS_PROVIDER` を外して GD | AI の発言がブラウザ合成で鳴り、「簡易モード」の注記が出る（無音にならない） |

## 9. 変更した既存ファイル（影響範囲）

| ファイル | 変更 |
|---|---|
| `app/career/gd/session/page.tsx` | textarea / 「発言する」/「AIの発言を進める」を撤去 → 音声。AI が口火を切る |
| `app/career/gd/room/[roomId]/page.tsx` | textarea / 「発言する」/ Enter 送信を撤去 → 音声 + mesh。開始前ゲート |
| `app/career/gd/setup/page.tsx` | 音声が使えないときは**テーマ生成より前**に開始を止める |
| `lib/interviewAi/tts.ts` | voice / speed / instructions の明示指定口（非破壊） |
| `lib/rateLimit/index.ts` | `career_gd_stt` / `career_gd_tts` の rule 追加 |
| `app/globals.css` | `.gdf-voice*`（状態表示。色だけに依存しない） |
| `types/env.d.ts` | STT/TTS provider・ICE の env を明示宣言 |
| `scripts/gd-qa/forestStage.qa.ts` | 入力欄前提の assertion を音声前提へ更新 |
| `tests/e2e/careerGd{Realtime,Invite,Lobby,Counts}.spec.ts` | 発言投入を API 経由へ。音声 UI の確認を追加 |

★ E2E の旧セレクタ `textarea[placeholder="あなたの発言を入力（600文字まで）"]` は、
本 STEP 以前から実際の placeholder と一致しておらず**既に壊れていた**（先行不具合）。
本 STEP で該当箇所ごと置き換えたため解消している。
