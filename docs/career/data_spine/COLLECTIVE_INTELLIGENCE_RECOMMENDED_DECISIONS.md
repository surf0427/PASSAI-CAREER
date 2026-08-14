# PASSAI CAREER — Collective Intelligence Recommended Decisions

**目的:** Human が **YES / NO で処理できる**まで絞った決裁票。

**前提（Decision Resolution Batch 後）:**

- **H-L8 の technical 部分は解決済み**（service-role boundary / identity strategy / ETL）
- 残る Human decision は **6 件**（H-L1〜H-L7 のうち H-L8 を除く）
- 決定前でも codebase は `FAIL CLOSED` で完成している
- `ACTIVATION_READY ≠ PRODUCTION_ENABLED` は維持

---

# 技術的に解決済み（Human decision から除外）

## ~~H-L8a — member request からの service-role 到達性~~ → **RESOLVED_TECHNICALLY**

member path を privilege-free な gate probe へ差し替え、privileged composition を
`lib/careerAggregate/batch/*.batch.ts` へ分離した。
`app/` 配下 363 ファイルからの **推移的 import graph 到達性がゼロ**であることを
QA `HDR-1` / `HDR-2` が実測で固定している。Human 判断は不要。

## ~~H-L8b — Layer 5 identity strategy~~ → **RESOLVED_TECHNICALLY**

I1 / I2 / I3 を比較し **I2（subject 対応表）** を採用。
純粋ロジックは実装済み、DDL は draft（未適用）。Human 判断は不要
（適用タイミングだけが H-L8 に残る）。

## ~~H-L8c — ETL / batch infrastructure~~ → **RESOLVED_TECHNICALLY**

provider-neutral batch runner を実装（idempotency / retry / cursor / dry-run /
failure state / rebuild）。特定 cloud に依存しない。Human 判断は不要
（実際の cron provisioning だけが H-L8 に残る）。

---

# H-L1 — Minimum cohort threshold

```text
Decision:
  Layer 4 aggregate を返してよい最小 unique-user 数（absolute / internal / user-facing / AI）。

Why needed:
  閾値が低すぎると小集団から個人が推測されうる。高すぎると初期データ量で何も出せない。
  privacy と utility のトレードオフであり、コードでは決められない product 判断。

Options considered:
  A（緩い）  5 / 10 / 20 / 50
  B（現状値） 10 / 20 / 50 / 100   ← 現在コードに入っている PROVISIONAL 値
  C（厳しい） 20 / 50 / 100 / 200

Claude recommendation:
  ★ B（現状値をそのまま確定）

Why:
  1. 現在の唯一の metric は `feature_usage_prevalence`（「その月にその機能を使ったか」の
     user-level boolean）。属性を持たず、cohort は `all` と `graduation_year` の 2 種類だけ。
     交差 dimension は **構造的に禁止**されており、company / university / gender 等は
     PROHIBITED_DIMENSIONS で拒否される。つまり小セル化の主要経路が既に塞がれている。
  2. その上で rare-category guard（graduation_year の support < 20 なら suppress）が
     別途かかるため、実効的には「卒年別は 20 人以上」が既に効いている。
     A を選ぶと絶対下限 5 が rare-category guard より緩くなり、guard の意味が薄れる。
  3. C は初期データ量では `all` cohort ですら user-facing 50 に届かない可能性が高く、
     「常に十分なデータがありません」となって機能が成立しない。
     C の追加安全性は 1. の構造的制約と重複しており、限界効用が小さい。
  4. AI context = 100 は「言い換えによる漏洩」を考慮した最保守設定として妥当。
     そもそも AI context は H-L3 で許可しない推奨（後述）なので実運用では効かない。

Risk:
  データ量が想定より少ない場合、user-facing（50）に届かず表示されない期間が続く。
  → これは **安全側の失敗**であり、閾値を下げる決定は後からできる。

Reversible?:
  ✅ 完全に可逆。閾値は config 値で、変更しても過去 artifact は再生成対象になるだけ。

Code behavior until approved:
  FAIL CLOSED。`COHORT_THRESHOLDS.status = 'PROVISIONAL'` のままで、
  activation gate が `cohort_threshold_not_configured` を返し Layer 4 は serve しない。

Human action required:
  「B（10 / 20 / 50 / 100）で確定してよいか？」に YES / NO。
```

---

# H-L2 — Retention

```text
Decision:
  データ種別ごとの保持期間と policy version。

Why needed:
  法的保持義務・削除義務はコードで断定できない。ただし「全部同じ期間」は設計として誤り。

Options considered:
  一律 90 日 / 一律 365 日 / **種別ごとに分ける**

Claude recommendation:
  ★ 種別ごとに分ける。product/engineering recommendation として以下:

  | データ種別 | 推奨 | 理由 |
  |---|---:|---|
  | raw eligible input（Event Log の集計入力） | **90 日** | 再集計に必要な window を確保しつつ最短。既に本文を持たない構造化 event |
  | pending moderation contribution | **30 日** | 審査待ちのまま滞留させない。期限超過は自動 reject（`expire` 遷移が既に存在） |
  | approved shared knowledge | **730 日**（2 選考年） | 選考情報は 1〜2 年で陳腐化。`FRESHNESS_POLICY` の stale 境界（30 ヶ月）と整合 |
  | aggregate artifact | **400 日** | 前年同月比を 1 回だけ見られる長さ。`AGGREGATE_TTL_HOURS`（8 日）は serve 期限で別物 |
  | operational logs（batch run / audit） | **180 日** | 障害調査に十分。識別子を含まないため長期保持の必要が薄い |

Why:
  - **再構築可能性**で分けている。aggregate は input から再生成できるので input より長く持つ必要が無い…
    のではなく逆で、input を消すと再生成できないため input(90) < artifact(400) は成立しない。
    → そこで **artifact は input より長く**し、input 削除後は「再生成できないが serve は続く」
      状態を許容する（invalidation が来たら該当 window は serve 停止＝安全側）。
  - pending を最短にするのは、審査されないまま個人由来テキストが滞留するのを避けるため。
  - approved を最長にするのは、それが唯一「他ユーザーに価値を提供している」データだから。

Risk:
  法定保存義務（もしあれば）と矛盾する可能性 → H-L7 の法務確認項目に含めた。

Reversible?:
  ⚠ **部分的**。期間を延ばすのは可逆。短くして削除した分は復元不能。
  → 初期は長めに設定し、法務確認後に短縮する運用を推奨。

Code behavior until approved:
  FAIL CLOSED。`evaluateRetentionPolicy(null) = NOT_CONFIGURED` → **serve しない**。
  ★ 自動削除は **しない**（未決状態での削除は不可逆な破壊になるため）。

Human action required:
  上表の 5 値を承認するか、修正値を指定。
```

---

# H-L3 — Aggregation usage purpose

```text
Decision:
  Layer 4 を何のために使うか（許可 purpose の確定）。

Why needed:
  purpose limitation は consent scope と 1:1 で結びついており、
  「何に使うか」を決めないと必要な consent も決まらない。

Options considered:
  A internal analytics のみ
  B internal + user-facing trend
  C internal + user-facing + AI context

Claude recommendation:
  ★ B（internal analytics + user-facing trend/reference）

RECOMMENDED ALLOWED PURPOSE:
  1. **product analytics（internal）**
     「どの機能がどの時期に使われているか」を運営が把握する。
  2. **user-facing trend / reference（参考情報）**
     「この時期は自己分析を始めている人が多い」程度の一般傾向。
     必ず disclaimer 付き・数値は suppression 済み。

RECOMMENDED FORBIDDEN PURPOSES:
  1. ❌ **ability / aptitude evaluation** — 能力・適性の評価
  2. ❌ **matching への入力** — スコア / ランキング / 候補生成
        （`CONSUMER_CAPABILITIES` で `matching` は **恒久禁止**として既にコード化済み）
  3. ❌ **hiring probability / 合否予測**
  4. ❌ **user-facing benchmark**（「あなたは平均より遅れています」型の比較）
        `PROHIBITED_RENDER_PHRASES` で表現レベルでも既に禁止済み
  5. ❌ **AI context への投入**（今回は許可しない）

Why:
  - 1〜3 は現在の architecture boundary（`D-L4`）に明確に反する。
    Event Log は「機能を使ったか」しか持たず、能力の代理変数にならない。
    それを能力・合否へ写像するのは **データが支えない推論**であり、
    ユーザーに誤った自己認識を与える。
  - 4 は比較による不安喚起であり、PASSAI の product 価値（本人の準備支援）と逆行する。
  - 5（AI context）を今回外すのは、AI が集計値を言い換える過程で
    「あなたは遅れている」に変質するリスクを、閾値だけでは制御しきれないため。
    B で運用実績を積んでから改めて判断すればよい（後から追加は容易）。

Risk:
  B でも「一般傾向の提示」が比較として受け取られる可能性は残る
  → disclaimer 文言の確認を H-L7 に含めた。

Reversible?:
  ✅ 可逆。purpose を増やすには consent scope の追加取得が必要（構造的に強制される）。

Code behavior until approved:
  FAIL CLOSED。全 consumer が `not_connected`。

Human action required:
  「許可 = internal + user-facing trend、禁止 = ability / matching / 合否予測 /
  benchmark / AI context」で YES / NO。
```

---

# H-L4 — Company Knowledge sharing policy

```text
Decision:
  private research と shared contribution の境界、および共有の同意方式。

Options considered:
  A contribution ごとに毎回明示 share
  B 一度 opt-in → その後は投稿時に個別確認
  C global consent のみで自動 share

Claude recommendation:
  ★ B（一度 opt-in + 投稿ごとの個別確認）

Why:
  - **C は既存 privacy invariant と矛盾する**。
    `source.company_research` は `PERSONAL_ONLY` に分類されており、
    `mayBeShared()` は false を返す。C を実装するには分類表を書き換える必要があり、
    それは「保存しただけのものが共有される」という Human 指示 §16 の禁止に直接反する。
    → **採用不可**。
  - A は最も安全だが、毎回の同意取得が摩擦になり、結果として誰も共有しない。
    集合知が成立しないなら Layer 5 を作る意味が無い。
  - B は「共有という purpose への同意」を 1 回取り（`company_knowledge_contribution` scope）、
    そのうえで **投稿ごとに何を共有するか本人が確認**する。
    現在の `evaluateSharingAdmission` はまさにこの形（scope 同意 AND contribution 単位の
    `consentState === 'share_granted'`）で既に実装されている。

  付随する推奨:
  - 商用利用: **prohibited のまま**（`prohibitedUses` に `commercial_resale`）。
    後から permitted へ移すには再同意が必要 — これが正しい向き。
  - `VERIFIED_PUBLIC_SOURCE`: **今回は実装しない**（型のみ）。
    official source の検証方針が無い状態で取り込むと provenance が壊れる。
  - 共有範囲: **全 member**（卒年限定にすると cohort が小さくなり、
    かえって contributor が推測されやすくなる）。

Risk:
  投稿ごとの確認 UI が必要（現在未実装）。ただし UI は activation 時の作業で、
  今回作るべきものではない（Human 指示 §14）。

Reversible?:
  ✅ 可逆。B → A への厳格化はいつでも可能。

Code behavior until approved:
  FAIL CLOSED。private research auto-share は **構造的に不可能**
  （変換 module が存在しないことを QA `CI-8` が固定）。

Human action required:
  「B + 商用禁止維持 + VERIFIED_PUBLIC_SOURCE 見送り + 全 member 公開」で YES / NO。
```

---

# H-L5 — 撤回後の published knowledge

```text
Decision:
  consent 撤回・アカウント削除後、既に published となった shared knowledge をどうするか。

Why needed:
  「本人が消したい」と「他ユーザーが既に参照している集合知」の衝突。
  匿名化の程度によって法的評価も変わるため、コードで断定できない。

Options considered:
  A 全削除
  B future 停止 + identifiable contribution 削除 + sufficiently derived knowledge 残存
  C future 停止のみ

Claude recommendation:
  ★ B（状態別に分ける）

  状態別の推奨挙動:

  | 状態 | 推奨 |
  |---|---|
  | pending（未審査） | **削除** — 誰にも届いていない。残す理由が無い |
  | rejected | **削除** — 同上 |
  | approved but unpublished | **削除** — 公開されていない |
  | published（単独 contribution 由来） | **unpublish** — 1 人の記述がほぼそのまま出ている |
  | published derived knowledge（複数寄与を統合） | **残存** — 特定個人の記述に還元できない |
  | aggregate knowledge（多数由来） | **残存** — 同上 |

Why:
  - A（全削除）は、複数人の寄与を統合した知見まで消す。
    他の contributor の寄与まで巻き添えで消えるため、**他者の意思を無視する**ことになる。
  - C（future のみ）は、本人の記述がほぼそのまま公開され続ける状態を許す。
    「撤回したのに自分の書いたものが残る」は期待に反する。
  - B の分岐点は **「特定個人の記述に還元できるか」**。
    現在のコードは `独立 corroboration 件数`（`MIN_CORROBORATION_FOR_TREND = 2`）で
    single_report と general trend を既に区別しているので、
    この境界をそのまま「削除する / 残す」の境界に使える。

  ★ I2 identity strategy により、**subject を unlink すれば contribution は再識別不能**になる。
    つまり「残す」を選んでも contributor へは辿れない。これが B を現実的にしている。

Risk:
  「derived」の判定が争点になりうる（何件から derived か）。
  → `MIN_CORROBORATION_FOR_TREND` の値そのものが H-L1 と同種の policy 値。
    暫定 2 を採用し、法務確認へ回す。

Reversible?:
  ❌ **削除は不可逆**。残す判断は後から削除できるが、逆はできない。
  → 迷う場合は「残す」ではなく「unpublish（非公開化）」を選ぶのが安全。
    unpublish は可逆で、削除は不可逆。

Code behavior until approved:
  FAIL CLOSED（最も保守的）。伝播表は `human_policy_required` を返し、
  **自動削除も自動継続もしない**。`revoked → future contributions blocked` のみ構造的に保証。

Human action required:
  上表 6 行を承認するか、修正。特に「published derived knowledge を残すか」に YES / NO。
```

---

# H-L6 — Moderation ownership

```text
Decision:
  誰が moderation を実行するか。

Options considered:
  A Human admin のみ
  B automated pre-screen + Human approval
  C automated approval

Claude recommendation:
  ★ B（automated pre-screen + Human approval）

Why:
  - **C は禁止**。`raw submission → auto published` は Human 指示 §20 で禁止されており、
    現在の lifecycle FSM も `privacy_review` / `moderation_pending` を経由しないと
    `published` へ到達できない（構造的に C を実装できない）。
  - A は投稿数が増えると運用が破綻する。ただし **現在の PASSAI 規模では A で十分**。
  - B は現在のコードに最も素直に載る:
    `pii.createDeterministicPiiScanner()` が pre-screen（PII / 秘密情報リスク）を行い、
    `fail_privacy_review → rejected` で機械的に落とす。
    残りを人が `approve` / `reject` する。
    → **pre-screen 部分は実装済み**。必要なのは承認する人と、その UI。

  運用パラメータの推奨:
  - SLA: 投稿から **72 時間以内**に一次判断（超過分は `expire` で自動 reject）
  - takedown 受付: 既存の `career_company_knowledge_takedown_requests` table を使う
  - legal hold の発動権限: 運営責任者のみ

Risk:
  「承認する人」が確保できないと Layer 5 は永久に有効化されない。
  → それは正しい失敗（moderation 不在で公開しないほうが安全）。

Reversible?:
  ✅ 可逆。B → A（全件手動）への厳格化はいつでも可能。

Code behavior until approved:
  FAIL CLOSED。`moderation_ready = false` → Layer 5 は activated=false。
  ★ moderation module が存在するだけでは ready と見なさない（`isAccidentalEnablePattern`）。

Human action required:
  「B + SLA 72 時間 + 承認者 = 運営」で YES / NO、および **承認者を誰にするか**の指名。
```

---

# H-L7 — Legal / privacy review checklist

```text
Decision:
  法務・プライバシー専門家の確認（Claude は法的結論を出さない）。

Human action required:
  以下 10 項目を専門家へ確認。PASSAI の実 data flow に対応させてある。
```

| # | 確認事項 | PASSAI での具体的対象 |
|---:|---|---|
| 1 | Layer 4 の集計値は「匿名加工情報」か「仮名加工情報」か | `feature_usage_prevalence`。user-level boolean を unique-count し、cohort は `all` / `graduation_year` のみ。個人単位の逆引きを保持しない |
| 2 | 集計への利用に明示 opt-in が必要な範囲 | `internal_aggregated_analytics` と `user_facing_aggregated_insight` を分けて取得する設計。両方に個別同意が必要か |
| 3 | 撤回前に生成された aggregate の扱い | 生成済み artifact から特定個人の寄与だけを差し引くことは **構造的に不可能**（window 単位の再生成のみ）。この制約が許容されるか |
| 4 | アカウント削除後の再計算義務 | 同上。削除後も過去 artifact が残ることの可否 |
| 5 | ユーザー投稿の企業情報の法的位置づけ | 選考体験（面接内容・選考フロー）の公開。名誉毀損 / 営業秘密 / NDA 抵触の線引き |
| 6 | 撤回後の published knowledge 削除義務 | H-L5 の 6 状態別挙動（特に「derived knowledge を残す」判断） |
| 7 | 同意文言と disclaimer 文言 | `AGGREGATE_DISCLAIMER`（非因果・非評価の明示）と共有同意文言の妥当性 |
| 8 | retention 期間の法的下限・上限 | H-L2 の 5 種別（90 / 30 / 730 / 400 / 180 日） |
| 9 | 同意証跡（consent ledger）自体の retention | append-only ledger。アカウント削除後も同意証跡を残すべきか / 残してよいか |
| 10 | 未成年ユーザーの扱い | 就活サービスの性質上、学部生に未成年が含まれうる。集計・共有への同意能力 |

```text
Code behavior until approved:
  FAIL CLOSED。`legalApproved = false` → Layer 4 / Layer 5 とも activated=false。
```

---

# H-L8 — Production infrastructure（technical 部分は解決済み）

```text
Decision:
  残るのは **provisioning の実行判断のみ**。

Resolved technically（Human 判断不要）:
  ✅ member request → service-role 到達性の除去（`D-R1` / QA HDR-1, HDR-2）
  ✅ Layer 5 identity strategy = I2（`D-R2` / QA HDR-3, HDR-4）
  ✅ provider-neutral batch runner（`D-R3` / QA HDR-7, HDR-8）

Remaining Human action:
  1. target project（既存 CAREER Supabase か別 project か）
  2. `supabase/prototype/collective_intelligence_activation_draft.sql` の適用可否
  3. batch 実行基盤の選択（Vercel Cron / pg_cron / GitHub Actions / 手動）
     ※ runner は provider-neutral なのでどれでも動く
  4. moderation backend UI の実装可否（H-L6 の承認者が決まってから）

Code behavior until approved:
  FAIL CLOSED。`infrastructureReady = false`。

Reversible?:
  ✅ 可逆（flag を戻せば即 OFF）。ただし DDL 適用は前進のみ。
```

---

# 決定サマリ（Human が答えるのはこれだけ）

| ID | 質問 | Claude 推奨 | 可逆性 |
|---|---|---|---|
| H-L1 | cohort 閾値は 10/20/50/100 でよいか | **B（現状値を確定）** | ✅ |
| H-L2 | retention を 5 種別（90/30/730/400/180 日）でよいか | **種別分け** | ⚠ 短縮は不可逆 |
| H-L3 | 用途を internal + user-facing trend に限定してよいか | **B（AI context は今回外す）** | ✅ |
| H-L4 | 共有は「一度 opt-in + 投稿ごと確認」でよいか | **B** | ✅ |
| H-L5 | 撤回後、derived knowledge は残してよいか | **B（状態別）** | ❌ 削除は不可逆 |
| H-L6 | moderation は自動 pre-screen + 人手承認でよいか / 承認者は誰か | **B** | ✅ |
| H-L7 | 法務 10 項目の確認 | — | — |
| H-L8 | infra provisioning の実行判断（technical は解決済み） | — | ✅ |

**技術的な未決事項はゼロ。** 残るのは policy / legal / provisioning の判断のみです。
