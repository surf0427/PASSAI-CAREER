# 就活版 企業マッチング 再設計（設計ドキュメント）

> 対象: `/career/matching`（就活版 企業マッチングAI）
> 注意: 本書は受験版 `/admission-matching`（[README.md](./README.md)）とは別機能。就活版は受験版のコピーではない（[app/api/career/matching/route.ts](../../app/api/career/matching/route.ts) 冒頭コメント参照）。
> ステータス: 設計確定前のレビュー用ドラフト。MVPスコープのみ着手合意済み（後述）。

## 0. 目的

現状のマッチングを「おすすめ企業の羅列」から、**「この人ならこの会社が向いている」をAIが根拠付きで説明できる、就活特化の企業マッチングAI**へ作り替える。
単なる求人検索との差別化は、6機能（profile / activity / values / selfAnalysis / es / interview / consultation）のデータ統合と、機能間の循環にある。

---

## 1. 現状把握（再設計の出発点）

- 実装: [app/api/career/matching/route.ts](../../app/api/career/matching/route.ts)、UI [app/career/matching/](../../app/career/matching/)、保存 [matchingStorage.ts](../../app/career/matching/matchingStorage.ts)（`careerMatchingResults`）。
- モデル: `claude-sonnet-4-6`。6機能＋userInputを統合入力にし、1回のLLM呼び出しで最大5社を返す。
- 出力: `profileSummary / careerType / recommendedIndustries / recommendedJobs / companyMatches[] / developmentAreas / nextSteps`。各社 `score(0-100) + matchReasons + strengthsUsed + attentionPoints + nextActions`。
- 既に受験版から分離済み。土台はある。**課題は「軸の反映度」「理由の具体性」「スコアの責任分担」「企業事実の扱い」**。

### 利用可能なデータ資産（マッチングの原材料）

| 機能 | 型 | マッチングで効く主フィールド |
|---|---|---|
| 就活軸 | [careerValues.ts](../../types/careerValues.ts) | 8カテゴリ: `priorities`(重視) / `avoidances`(避けたい) / `industries` / `jobTypes` / `workStyles` / `companyTypes` / `careerGoals` / `culturePreferences` |
| 自己分析 | [careerSelfAnalysis.ts](../../types/careerSelfAnalysis.ts) | v2構造化: `valueKeywords` / `strengthKeywords` / `motivationSources` / `stressFactors` / `companySelectionCriteria` / `suitableEnvironment` / `recommendedIndustries` / `recommendedJobs` / `developmentPoints` |
| 活動整理 | [careerActivity.ts](../../types/careerActivity.ts) | 経験系の `quantitativeResult`(定量実績) / `ingenuity` / `role` / `scale` = 強みのエビデンス |
| 面接 | [careerInterview.ts](../../types/careerInterview.ts) | `CareerInterviewFinalResult.strengths / improvements` = コミュ特性・論理性 |
| ES | [careerEs.ts](../../types/careerEs.ts) | `appealPoints / headline` = 自己表現の整合性 |
| 基本情報 | [careerProfile.ts](../../types/careerProfile.ts) | `graduationYear` 等 |

---

## 2. 設計を縛る2つの制約（必読）

### 制約A: Web検索 vs 「事実を創作しない」
- [docs/principles/ai_policy.md](../principles/ai_policy.md): **入力にない事実の創作を絶対禁止**。現コードも「Web検索は常時実装しない／年収・福利厚生の断定禁止」。
- 解: **LLMの記憶から企業事実を語らせるのは禁止。出典付きの検証済み事実なら断定してよい。** → 「事実レイヤ／推測レイヤ」を型で分離して構造的に解決（§5）。MVPではWeb検索を入れず、数値は「公式要確認」で誠実に逃がす。

### 制約B: スコアの責任分担
- [docs/principles/ai_score_contract.md](../principles/ai_score_contract.md): **AIに合計を保証させるな。deterministicに再計算して上書きせよ。** 受験版マッチングは準拠（AIは理由のみ、スコアは計算層）。
- 解: 就活版もここへ寄せる。**AIは軸ごとのfit小スコア＋根拠のみ。総合マッチ度はサーバが重み付け合算。** これが説明可能性も同時に実現する。

---

## 3. 理想構造（データの流れ）

「全部を1回のLLMに投げて5社」を、レイヤ分割パイプラインへ。

```
レイヤ0  ユーザープロファイル統合（deterministic, LLMなし）
         6機能 → MatchProfile { 軸ベクトル, 強み, ストレス要因, 実績エビデンス, コミュ特性 }
レイヤ1  候補企業の生成（LLM #1: 推論）       … 候補出しは推測でOK、後段で検証
         MatchProfile → 向いている業界/職種 + 候補企業20〜30社
レイヤ2  企業の事実取得（企業DB + Web検索, 出典必須）★中期
         候補各社 → CompanyFacts（verified=出典付きのみ採用、無ければ不明。創作禁止）
レイヤ3  相性スコアリング（LLM #2: 軸ごと評価のみ）
         (MatchProfile × CompanyFacts) → 軸別fit小スコア + 各軸の根拠文（総合点は出さない）
レイヤ4  総合スコア合算（deterministic, LLMなし）★score_contract準拠
         軸別小スコア × 動的重み → 総合マッチ度（サーバ計算、avoidancesはキャップ）
レイヤ5  理由・懸念・成長提案の生成（LLM #3: 説明文）
         上位N社の 向く理由 / 懸念 / 活かせる経験 / 伸ばす力（事実はレイヤ2の出典のみ参照）
```

理由: コスト制御（候補30社→事実取得→高価なLLM評価は上位のみ。受験版の per-univ 段階呼び出し前例あり）、軸別の追跡可能性、断定の安全性。

---

## 4. アルゴリズム（固定重みを捨て、就活軸を重みにする）

**最大の転換: 汎用の固定重み（軸40%/自己分析25%…）ではなく、`careerValues` = ユーザー自身が選んだ重みを使う。**

### マッチング次元（軸）と入力ソース

| 軸 | 主ソース |
|---|---|
| 年収・待遇 | values.priorities, companySelectionCriteria |
| WLB・働き方 | values.workStyles, suitableEnvironment, stressFactors |
| 成長環境・裁量 | values.careerGoals, motivationSources |
| 安定 vs 挑戦 | values.companyTypes |
| 社風・人間関係 | values.culturePreferences, 面接の人柄評価 |
| 業界フィット | values.industries, selfAnalysis.recommendedIndustries |
| 職種フィット | values.jobTypes, recommendedJobs |
| 強みの活用度 | activity(定量実績), strengthKeywords |
| 国際志向 | activity.overseas/languages |
| 勤務地・転勤 | values.priorities/avoidances |

### 重みの決め方（2段）
1. **ユーザー明示の重み**: `priorities`で選んだ軸=高重み。`avoidances`=**ディールブレーカー**（減点ではなく総合スコアの上限キャップ。例: 転勤NGユーザーで転勤ありの会社は最大60点に頭打ち）。
2. **業界・職種補正**: 軸の意味は業界で変わる。業界×軸の重み係数テーブルをコードで保持（LLMに毎回決めさせない＝再現性・コスト）。

### スコア計算（score_contract準拠）
```
総合マッチ度 = Σ(軸別fit小スコア × 動的重み) / Σ重み      ← サーバ計算
　avoidances該当軸があれば total = min(total, capValue)
```
- AIは軸別小スコアと根拠文のみ返す。`clampScore` を軸別に流用。
- **AIのtotalScoreを画面に直接バインドしない**を厳守。
- values未入力者のフォールバック重みのみ: 就活軸35 / 自己分析25 / 活動15 / 面接10 / ES5 / 相談10（保険であり本筋ではない）。

---

## 5. CompanyFacts スキーマ（事実/推測の型分離）★中期

```ts
type SourceRef = { url: string; title: string; kind: 'official'|'ir'|'recruit'|'review'|'news' };

type CompanyFacts = {
  // 事実レイヤ（出典必須。無ければ undefined。創作禁止）
  verified: {
    businessSummary?: { value: string; source: SourceRef };
    employeeCount?:   { value: number; source: SourceRef };
    avgSalary?:       { value: string; source: SourceRef };   // 有報/公開情報のみ
    locations?:       { value: string[]; source: SourceRef };
    newGradInfo?:     { value: string; source: SourceRef };
    idealCandidate?:  { value: string; source: SourceRef };   // 採用ページ原文
  };
  // 推測/傾向レイヤ（「一般に語られる傾向」とラベル、断定しない）
  inferred: {
    cultureTendency?: string;
    youngDiscretion?: string;
    growthEnv?: string;
    // 各項目 confidence: 'low'|'mid'|'high'
  };
  sources: SourceRef[];
};
```
評価観点: 求める人物像 / 社風 / 成長環境 / 若手裁量 / 評価制度 / 離職率傾向 / 平均年収 / 勤務地 / 福利厚生 / 海外展開 / DX・技術スタック。数値系は verified にあるものだけ断定、無ければ「公式で要確認」。

---

## 6. ユーザー表示（企業カード）

```
株式会社◯◯  [総合マッチ度 87%]
▸ 軸別レーダー: 年収◯ 成長◎ WLB△ 裁量◎ 安定○      ← 軸別小スコア可視化
✓ 向いている理由（あなたのデータ由来）
   ・活動の定量実績「△△」が、この会社の求める□□と直結   ← activity引用
   ・面接で評価された「論理性」が活きる                  ← interview引用
⚠ 懸念点・見極めポイント
   ・WLB軸が優先度の割に△                              ← avoidances/stressFactorsとの摩擦
   ・年収は公式情報で要確認（出典なし）                  ← 事実が取れなければ正直に
🎁 入社後に活かせる経験 / 📈 入社前に伸ばすべき力（developmentPoints連動）
🔗 出典チップ（事実/推測を可視化） / ▸ 次アクション → ES機能へ
```
原則: 理由は必ず**ユーザー自身のデータを引用**（一般論にしない）。懸念点の摩擦を隠さない。出典で透明性。

---

## 7. PASSAI独自の価値

1. 逆引き（なぜ向いていないか）も言える → developmentPointsへ接続。
2. 機能間ループ: マッチ結果→ES/面接へ志望企業コンテキストを渡すハブ化。
3. データが増えるほど精度が上がる体験を可視化（入力動機化）。
4. ES/values/自己分析間の矛盾をAIが指摘し軸の言語化を促す（ai_policyの「思考整理・深掘り」に合致、代筆ではない）。

---

## 8. ロードマップ（MVP / 中期 / 長期）

### 🟢 MVP（着手合意済みスコープ: Web検索・企業DBなし）
既存 route.ts の改修で完結。Web検索を入れず、企業数値は「公式要確認」で逃がす（現ポリシーと無衝突）。

| 優先 | 項目 |
|---|---|
| 1 | レイヤ0 `MatchProfile` 統合を deterministic 実装。values8カテゴリ＋selfAnalysis v2 をマッチング軸へマッピング |
| 2 | スコアを score_contract 準拠化: AIは軸別小スコア＋根拠、総合はサーバ合算。`avoidances` をキャップ化 |
| 3 | 理由生成を「ユーザーデータ引用必須」に強化（activity定量実績・interview評価を必ず参照） |
| 4 | UIに軸別スコア（レーダー/バー）＋「事実/推測ラベル」追加 |

### 🟡 中期（MVP安定後）
1. キュレーション済み企業DB（主要数百〜千社の verified facts シード）。Web全文検索より先。
2. レイヤ2のWeb検索を出典付き・事実限定で追加（`WebSearch`/`WebFetch`）。`CompanyFacts.verified` のみ採用。**ai_policy更新が前提**。
3. 段階呼び出し（候補→事実→上位のみLLM評価）＋ `logAiUsage` 必須（observability要件）。
4. 機能間ループ実装。

### 🔴 長期（ユーザー増加後・データフライホイール）
- 内定者プロファイル学習（匿名集計）→「似た人はこの業界に内定」。
- OB/OG・入社後満足度・キャリア追跡の取り込み。
- マッチ結果と実応募/通過の突合 → 業界×軸の重み係数を実データで較正。
- Supabase正本化（現状localStorage正本、mirror Phase1 frozen）後に集計基盤を構築。

---

## 9. 実装ゲート（着手前チェック）

- [ ] AIに総合点を出させていないか（軸別のみ）
- [ ] `avoidances` を減点でなくキャップで扱っているか
- [ ] 理由がユーザーデータ引用になっているか（一般論でないか）
- [ ] 入力で証明できない企業事実を断定していないか
- [ ] `logAiUsage()` を全AI呼び出しに付けたか
- [ ] 表示は server-side normalize 経路のみ参照しているか
