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
| 8 | 音声 QA（168 checks） | `scripts/gd-qa/voice.qa.ts`（`npm run qa:careerGdVoice`） |

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
| `NEXT_PUBLIC_CAREER_GD_ICE_SERVERS` | TURN の JSON 配列 | **マルチ公開には必須** | 公開 STUN のみになり、mesh のペア数ぶん失敗が増幅する。**マルチ音声 GD の Production Blocker**（§7-1）。ソロは影響を受けない |

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

1. **TURN 未設定はマルチ音声 GD の Production Blocker（監査で「warning」から格上げ）。**
   公開 STUN のみでは対称 NAT（国内モバイル回線の CGNAT・企業 NW）配下で P2P を確立できない。
   ★ mesh では **全ペアが個別に接続を張る**ため、失敗確率がペア数で増幅する:

   | 人間参加者 | ペア数 | ペア失敗率 10% のとき「誰か 1 人でも聞こえない」確率 |
   |---|---|---|
   | 2 人 | 1 | 約 10% |
   | 4 人 | 6 | 約 47% |
   | 6 人 | 15 | 約 79% |
   | 8 人 | 28 | 約 95% |

   つまり TURN 無しでは、4 人 GD の約半数・6〜8 人 GD のほぼ全部で
   「誰かの声だけ聞こえない」状態になる。「文字起こしは共有されるから可」とはしない
   （商品は音声 GD であり、これは縮退ではなく不成立）。
   → **`NEXT_PUBLIC_CAREER_GD_ICE_SERVERS` に TURN を設定するまでマルチは公開しない。**
   ソロ GD は mesh を使わないため、この制約の影響を受けない。
   なお失敗そのものは無言にしない（`GdVoiceBar` が相手名つきで表示する）。

1-b. **signaling の認可は application 層のみ（channel 層は未設定）。**
   Supabase Broadcast の channel は既定で認可が無く、channel 名（roomId）を知る者は
   購読・送信ができる。そのため mesh は `from` を**在籍中の人間参加者名簿と照合**し、
   一致しない signal を一切処理しない（非参加者・退室者は peer になれない）。
   照合先の participantId は server 生成 UUID で membership 認可済み API 経由でしか得られず、
   roomId も UUID なので実効的な境界になる。
   ★ ただし **完全な防御は channel 層**（Supabase Realtime Authorization / private channel と
   `realtime.messages` の RLS ポリシー）であり、これは未適用。運用者が適用すれば
   「そもそも購読できない」まで強化できる（本 STEP では DDL を増やさない方針で見送り）。
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

### 8-1. 端末マトリクス（**同一 Wi-Fi だけでは不十分**）

TURN の要否と mesh の実効は、**NAT をまたぐ組み合わせ**でしか判定できない。
同一 Wi-Fi 上の 2 端末は同一 LAN の host candidate で繋がってしまい、
本番で最も多い「モバイル回線の参加者」を一切検証できない。

| | Device A | Device B |
|---|---|---|
| 端末 | Mac | iPhone |
| ブラウザ | Safari または Chrome | iOS Safari（browser tab。PWA ではない） |
| 回線 | Wi-Fi | **4G / 5G（Wi-Fi を必ず切る）** |

### 8-2. SOLO 実機チェック

| # | 手順 | 期待 |
|---|---|---|
| 1 | `/career/gd/setup` → GD を始める | 音声が使えない環境なら**テーマ生成の前**に開始が止まる |
| 2 | 「マイクを有効にする」 | 権限ダイアログが出て `ready` になる |
| 3 | そのまま待つ | AI が先に口火を切り、**その声が鳴る**（iOS の解除が効いている証拠） |
| 4 | 「はい」だけ発話 | 短い発言が捨てられずログに出る |
| 5 | 通常の長さで発話 | 語頭・語尾が欠けずに文字起こしされる |
| 6 | 30 秒以上続けて発話 | 途中で強制分割されるが内容が欠落しない |
| 7 | 「長い発言」→ 直後に「確かに」 | **ログの順序が発話順どおり**（STT 直列化の実証。逆順なら回帰） |
| 8 | ミュート → 20 秒放置 | Whisper へ送られない（ネットワークタブに stt request が出ない） |
| 9 | ミュート解除 | **権限の再プロンプトが出ず**そのまま発言できる |
| 10 | GD を終了 → 評価 | 評価が生成され、結果が保存される |
| 11 | 結果画面へ遷移後 | 録音インジケータが消える（マイクが解放されている） |

### 8-3. MULTI 実機チェック（A=Mac/Wi-Fi, B=iPhone/4G）

| # | 手順 | 期待 |
|---|---|---|
| 1 | A が部屋作成 → B が参加 | 両者が待機画面で互いを認識する |
| 2 | A が開始 | 両者が進行画面へ。文字入力欄は存在しない |
| 3 | A が発話 | **B に A の生の声が聞こえる** |
| 4 | B が発話 | **A に B の生の声が聞こえる** |
| 5 | 両者の音声バー | `参加者の音声: 1 / 1 人と接続中`。失敗なら相手名つきで表示される |
| 6 | A の文字起こし | A・B 双方のログに出る |
| 7 | B の文字起こし | A・B 双方のログに出る |
| 8 | A がミュート | B に A の声が届かない。B の声は A に届き続ける |
| 9 | A がミュート解除 | 再プロンプト無しで復帰 |
| 10 | 「AIに発言してもらう」 | AI の声が鳴り、**両者で 1 回だけ**（重複読み上げが無い） |
| 11 | AI が連続発言 | seq 順に 1 件ずつ鳴る（同時再生・逆順が無い） |
| 12 | B が退出 | A 側の peer が閉じ、A の画面が壊れない |
| 13 | B が再入室 | 再び音声が繋がる |
| 14 | host が終了 | 両者が終了状態へ。**読み上げが止まる** |
| 15 | 評価 → 履歴 | 評価が生成され、履歴に残る |

### 8-4. TURN relay の実機確認（**credential は表示しない**）

TURN が実際に使われたかは、**relay candidate が 1 つでも生成されたか**で判定する。

Chrome:

1. GD 進行中に別タブで `chrome://webrtc-internals` を開く。
2. 対象の `RTCPeerConnection` を選ぶ。
3. `iceCandidatePairs` / イベントログで `candidateType` が
   **`relay`** の candidate が存在することを確認する。
   `host` / `srflx` しか無ければ TURN は使われていない。
4. `Stats` の `candidate-pair` で `state: succeeded` の pair の
   `localCandidateId` を辿り、その `candidateType` を確認する。

Safari:

1. 「開発」メニュー →「Web インスペクタ」→ コンソール。
2. 進行中に以下を実行（**URL・username・credential は出力しない**。type だけ見る）:

```js
// ページ内で保持している peer connection を直接は参照できないため、
// 一時確認としては Chrome の webrtc-internals を正とする。
// Safari 単独で見る場合は、接続後に「相手の声が聞こえるか」で代替判定する。
```

★ 限界: **relay candidate の生成はコード検査・自動 QA では確認できない**。
`NEXT_PUBLIC_CAREER_GD_ICE_SERVERS` の parse と RTCPeerConnection への引き渡しまでは
`qa:careerGdVoice` が検証するが、実際に TURN サーバへ到達して relay が取れたかは
上記の実機手順でしか確定しない。

### 8-5. ネットワーク障害シナリオ

| # | 操作 | 期待される挙動 | 判定 |
|---|---|---|---|
| 1 | B を Wi-Fi → 4G へ切替 | 音声が切れる。音声バーが接続失敗または再準備を**表示する** | 現仕様では**自動復帰しない**（要リロード）。表示されるので acceptable degradation |
| 2 | 一時的に圏外 → 復帰 | 同上。文字起こしは復帰後の発言から再開する | acceptable degradation |
| 3 | 片方が退出 | 残った側の peer だけが閉じ、他は維持される | 必須（壊れたら blocker） |
| 4 | マイク権限を拒否 | 復帰手順の文言が出る。無反応にならない | 必須 |
| 5 | Safari を背面 → 前面 | 前面復帰後に発言・再生が継続する | 要実機確認 |
| 6 | 端末をロック → 解除 | 解除後に発言・再生が継続する。継続しない場合はリロードで復帰できる | 要実機確認 |

★ シグナリング channel は**自動再接続しない**（既存 `CareerGdRealtimeRoom` と異なり
`scheduleReconnect` を持たない）。回線切替後に新しい参加者と繋がらなくなるが、
`signalingConnected=false` として UI に出るため無言では壊れない。
seamless recovery は現仕様ではなく、**リロードが回復手段**である。

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
