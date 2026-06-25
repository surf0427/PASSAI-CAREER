# 就活版 企業マッチング 第三弾 — 実装設計レビュー

> 対象: `/career/matching`（就活版）
> 前提: 第一弾 [career_matching_redesign.md](./career_matching_redesign.md) / 第二弾 [career_matching_redesign_phase2.md](./career_matching_redesign_phase2.md) で確定済みの仕様を実装に落とす。
> リファレンス（家のスタイル）: 受験版 [lib/matching/calculateScore.ts](../../lib/matching/calculateScore.ts)、[lib/statement/score/statementScore.ts](../../lib/statement/score/statementScore.ts)。
> ステータス: 実装着手前レビュー。

## 0. 最重要指摘（先に潰すべき矛盾）

**現状の就活版APIは確定仕様④に違反している。** [app/api/career/matching/route.ts](../../app/api/career/matching/route.ts) は AI が `score:number` を直接返し、サーバは `clampScore` で丸めるだけ。これは「AIは小スコア・サーバが総合」契約に反する。
→ フェーズ3の第一作業は **スコア生成をLLMから決定的エンジンへ移設**すること。受験版 `calculateScore.ts` が既にこの正しい形（AIは理由のみ・サーバが `buildBreakdown`）を実装しているので、就活版もこの構造へ寄せる。これが本設計の背骨。

---

## ① 責務分離レビュー（AI / サーバ / UI）

確定仕様の方向は正しい。改善点を3つ。

| レイヤ | 担当 | 改善指摘 |
|---|---|---|
| **AI** | 軸別fit小スコア(0-100)＋根拠、readiness/success 各小シグナルの推定値＋根拠、企業の推測情報(社風・選考ティア) | **固定スキーマ厳守**。AIに「総合・順位・%・Δ」を一切返させない。出力は `{ key, value, rationale }[]` の形に限定し、自由な構造を許さない（パース安定とExplainabilityのため） |
| **サーバ** | 総合スコア・順位・キャップ・不足優先度・ロードマップ順序・シミュレーション | 全て**純粋関数**。`measured` シグナル（既存機能の実数値）はAIを通さず直接読む |
| **UI** | 表示と「もし〜」操作のみ。計算ロジックを持たない | シミュレーションのΔ表示も**サーバ純粋関数の戻り値を描画するだけ**にする（UIで再計算しない） |

**追加すべき責務分担の原則**:
- **measured-first**: 数値が既存機能から取れるシグナル（プレゼンの level 平均、将来のSPI）は AI を通さない。AIは「数値が無い質的データの判断」だけに使う。これがAIの責任範囲を広げすぎない歯止め。
- **AIの出力はシグナル化の手段であって、スコアの源泉ではない**。AIが落ちても measured シグナル＋デフォルトで縮退動作する。

---

## ② スコアリングエンジン設計（純粋関数モジュール）

### 配置
`lib/careerMatching/` を**新規フィーチャーモジュール**として作る（`lib/careerAi/` と同格の自己完結モジュール。受験版 `lib/matching/` とは別物・混在させない）。flat ルールの例外ではなく、`lib/careerAi/` 同様のモジュール扱い。

```
lib/careerMatching/
  index.ts            … 公開API（ここ以外からは内部を import しない）
  types.ts            … 後述の interface 群（唯一の契約）
  buildMatchProfile.ts… 6機能の生データ → MatchProfile（アンチコラプション層）
  signals.ts          … SignalKey 定義 + measured抽出 + 欠損補完
  weights.ts          … careerValues→重み変換、業界×軸の重み係数テーブル
  scoreMatch.ts       … scoreMatch(profile, company): ScoreBreakdown
  scoreReadiness.ts   … scoreReadiness(profile, company): ScoreBreakdown
  scoreSuccess.ts     … scoreSuccess(profile, company): ScoreBreakdown
  caps.ts             … applyAvoidanceCaps(total, profile, company)
  ranking.ts          … calculateRanking(results[])
  gaps.ts             … analyzeGaps(profile, company)  ※感度計算でscore*を呼ぶ
  roadmap.ts          … buildRoadmap(gaps, schedule)
  simulate.ts         … simulate(profile, companies, deltas) ※score*を再実行
  engine.ts           … runCareerMatch(profile, companies): 上記を統合する純粋関数
```

### 設計の肝：③④⑤⑥⑦⑧は全て `score*` 3関数の再利用で出る
- **不足優先度(⑥/gaps.ts)** = 各シグナルを一定量(例+20)上げて `scoreReadiness` を再計算した時の Δtotal。大きい順。
- **シミュレーション(⑧/simulate.ts)** = 指定 delta を適用して `score*` と `ranking` を再実行するだけ。**LLM不使用**。
- **ロードマップ(⑦/roadmap.ts)** = gaps を「依存→締切→レバレッジ」で並べ、各 gap に PASSAI機能リンクを付与。
→ `gaps` と `simulate` は同じ感度エンジンの別ビュー。**スコア計算の真実は `score*` 3関数だけに存在する（唯一のスコアリングエンジン）**。

### 純粋関数の形（家のスタイル `calculateScore.ts` / `statementScore.ts` を踏襲）
```ts
const READINESS_KEYS = ['es','interview','gd','presentation','spi','gakuchika','english','activity'] as const;

function clampScore(v: unknown): number {            // 既存就活版と同名・同挙動を流用
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, Math.round(n)));
}

// 欠損(present:false)は 0 ではなく「重みから除外」。statementの total=sum と同型だが
// 欠損を分母から外すことで「未入力でも破綻しない」(確定仕様⑩)を実現。
function buildBreakdown(items: BreakdownInput[]): ScoreBreakdown {
  const active = items.filter((i) => i.present);
  const totalWeight = active.reduce((s, i) => s + i.weight, 0) || 1;
  const breakdownItems = active.map((i) => {
    const max = (i.weight / totalWeight) * 100;
    const contribution = Math.round((i.value / 100) * max);
    return { key: i.key, value: i.value, weight: i.weight, contribution, source: i.source, rationale: i.rationale };
  });
  const total = Math.min(100, breakdownItems.reduce((s, i) => s + i.contribution, 0));
  const confidence = computeConfidence(items);          // present×measured比率→'high'|'mid'|'low'
  return { items: breakdownItems, total, confidence, missingKeys: items.filter(i=>!i.present).map(i=>i.key) };
}
```
**3スコア(match/readiness/success)は同じ `ScoreBreakdown` 型を返す**。Explainability(各itemのcontribution+rationale)と欠損表示(missingKeys+confidence)が型レベルで保証される。

### avoidances キャップ（確定仕様②）
```ts
function applyAvoidanceCaps(total: number, profile: MatchProfile, company: CompanyInput): { total: number; appliedCaps: AppliedCap[] } {
  // avoidances の各項目が company の(inferred)属性に該当したら、減点でなく上限を被せる
  // 例: '全国転勤がある' 該当 → cap=70。複数該当時は最小capを採用。
  const caps = profile.avoidances.flatMap((a) => matchAvoidance(a, company)); // {label, cap, source}[]
  if (caps.length === 0) return { total, appliedCaps: [] };
  const cap = Math.min(...caps.map((c) => c.cap));
  return { total: Math.min(total, cap), appliedCaps: caps };
}
```
キャップは **match度に対して**適用（「望ましさ」の上限。readiness/successには掛けない）。`appliedCaps` を返すことで「なぜ70止まりか」をUIで説明できる。

---

## ③ 型設計（`lib/careerMatching/types.ts`）

```ts
// ── シグナル（確定仕様⑩の present/source 構造）──
export type SignalSource = 'measured' | 'inferred' | 'absent';
export type SignalKey =
  | 'es' | 'interview' | 'gd' | 'presentation' | 'spi'
  | 'gakuchika' | 'english' | 'activity' | 'leadership' | 'tech' | 'portfolio';

export type Signal = {
  key: SignalKey;
  value: number;            // 0-100
  present: boolean;
  source: SignalSource;
  rationale: string;        // なぜこの値か（Explainability）
};

// ── ユーザー側の統合プロファイル（6機能を1つに正規化）──
export type MatchProfile = {
  // values（重みの源泉）
  priorities: string[];
  avoidances: string[];
  interests: { industries: string[]; jobTypes: string[]; workStyles: string[]; companyTypes: string[]; careerGoals: string[]; culturePreferences: string[] };
  // 自己分析由来
  valueKeywords: string[]; strengthKeywords: string[]; motivationSources: string[];
  stressFactors: string[]; suitableEnvironment: string[]; developmentPoints: string[];
  // readiness/success シグナル
  signals: Record<SignalKey, Signal>;
  // メタ
  schemaVersion: number;    // 後方互換のための版数（後述の負債対策）
  completeness: number;     // 入力充足度 0-1（confidence算出に使用）
};

// ── 企業（MVPは inferred 中心、中期に CompanyFacts で verified 拡張）──
export type CompanyAttribute<T> = { value: T; source: SourceRef };
export type SourceRef = { kind: 'official'|'ir'|'recruit'|'review'|'news'|'inferred'; url?: string; title?: string };

export type CompanyInput = {
  name: string;
  verified: Partial<{ businessSummary: CompanyAttribute<string>; employeeCount: CompanyAttribute<number>; avgSalary: CompanyAttribute<string>; locations: CompanyAttribute<string[]>; idealCandidate: CompanyAttribute<string> }>;
  inferred: Partial<{ cultureTendency: string; youngDiscretion: string; growthEnv: string; selectionTier: 'S'|'A'|'B'|'C'; attributes: string[] }>;
  roleSuccessFactors: string[];   // 職務の成功要因（職種テンプレ＋inferred）
};

// ── スコア内訳（match/readiness/success 共通）──
export type ScoreBreakdownItem = { key: string; value: number; weight: number; contribution: number; source: SignalSource; rationale: string };
export type Confidence = 'high' | 'mid' | 'low';
export type ScoreBreakdown = { items: ScoreBreakdownItem[]; total: number; confidence: Confidence; missingKeys: string[] };
export type AppliedCap = { label: string; cap: number; source: SourceRef };

// ── 不足・ロードマップ・シミュレーション ──
export type Gap = { key: SignalKey; label: string; current: number; deltaIfImproved: number; feature: CareerFeatureLink; priority: number };
export type CareerFeatureLink = { featureKey: CareerAiFeatureKey; href: string; label: string };
export type RoadmapStep = { order: number; gap: Gap; reason: string; expectedReadinessGain: number };

export type SimulationInput = { changes: Array<{ key: SignalKey; toValue: number }> };
export type SimulationResult = {
  before: CompanyScore[]; after: CompanyScore[];
  rankingDelta: Array<{ company: string; from: number; to: number }>;
  scoreDelta: Array<{ company: string; match: number; readiness: number; success: number }>;
};

// ── 企業1社の最終スコア ──
export type CompanyScore = {
  company: string;
  match: ScoreBreakdown;
  readiness: ScoreBreakdown;     // 表示名は「選考準備度」
  success: ScoreBreakdown;
  appliedCaps: AppliedCap[];
  gaps: Gap[];
  roadmap: RoadmapStep[];
  reasons: string[];             // AI生成（ユーザーデータ引用必須）
  attentionPoints: string[];
  sources: SourceRef[];
};

// ── エンジン全体の戻り（永続化単位）──
export type CareerMatchEngineResult = {
  schemaVersion: number;
  generatedAt: string;
  profileSummary: string;
  companies: CompanyScore[];     // ranking 済み
};
```
**設計判断**: `match/readiness/success` を**同一 `ScoreBreakdown` 型**に統一 → UI・normalize・simulate を1経路で書ける。第二弾の「3スコア直交」を型で表現しつつ、内部表現は共通化。

---

## ④ UI設計

### 階層
```
/career/matching            … 入力充足チェック＋実行（既存踏襲）
/career/matching/result     … 企業リスト（カード）
/career/matching/result/[i] … 企業詳細（詳細画面）※新規
（シミュレーションは詳細画面内のパネル。専用ページは作らない＝MVP）
```

### 企業カード（リスト、要点のみ）
```
株式会社◯◯                                   [総合順位 #1]
マッチ度 92  選考準備度 68  活躍 74   確信度:中ⓘ
不足TOP: SPI(+11) / 面接(+7)            [詳細を見る]
```

### 企業詳細画面（コンポーネント分割）
```
<ScoreHeader>        3スコア＋confidenceバッジ＋合否非保証注記（確定仕様⑨）
<ScoreBreakdownPanel match|readiness|success>
   軸別バー: 各 item.contribution を表示、source(measured✓/inferred〜)アイコン
   appliedCaps があれば「転勤NGのため上限70」と明示
<ReasonsPanel>       AI根拠（ユーザーデータ引用）、Verified/Inferred をタグで色分け
<GapPanel>           不足を priority 順、各 +Δ% と [機能へ] リンク
<RoadmapPanel>       Step1→Step2… 各ステップに機能リンク＋expectedReadinessGain
<SimulationPanel>    チェック/スライダーで changes 構築→サーバ呼び→ before/after 差分描画
                     「準備度の試算であり合否予測ではない」注記
```
**UI原則**: 計算は一切UIに置かない。`CompanyScore` を描画するだけ。シミュレーションも入力(SimulationInput)を作ってサーバに渡し、`SimulationResult` を描くのみ。

---

## ⑤ 実装順序（既存への安全な組み込み = Strangler）

既存 `/career/matching` を壊さず、エンジンを脇に立ててから差し替える。

1. **エンジンの骨格（純粋・UIなし）**: `lib/careerMatching/` に types + `buildMatchProfile` + `signals` + `weights` + `scoreMatch` を実装。**この時点で QA スクリプト（後述）を必ず付ける**。既存APIには触らない。
2. **readiness/success + caps + ranking**: 残りの `score*`・`caps`・`ranking`・`engine` を追加。まだ measured シグナルのみ（AI推定シグナルは後）。
3. **AI出力スキーマの差し替え**: route.ts のAIを「score を返す」から「小スコア＋根拠＋推測情報のみ返す」へ変更。`normalizeResult` を廃し、AI出力を `Signal[]`/`CompanyInput.inferred` にマップ→`runCareerMatch` を呼ぶ。**ここで仕様④違反を解消**。出力 `CareerMatchEngineResult` を返す。
4. **gaps + roadmap + simulate**: エンジンに追加。route に `?simulate` 分岐 or 専用サブルートを足す。
5. **UI**: 詳細画面とパネル群。`careerMatchingResults` の保存形を新 `CareerMatchEngineResult`(schemaVersion付き)へ。旧データは version 判定で「再実行を促す」フォールバック。
6. **`logAiUsage()`** を全AI呼び出しに付与（observability要件）。

各ステップが独立リリース可能（rollback safety 最優先のhouse方針に合致）。

---

## ⑥ 将来拡張レビュー（設計を壊さず追加できるか）

| 拡張 | 接続点 | 評価 |
|---|---|---|
| Web検索 / CompanyFacts | `CompanyInput.verified` を埋める **CompanyFactsProvider** インターフェースを切る。MVPは「inferredのみ返すProvider」、中期は「Web/DBで verified を埋めるProvider」に差し替え | ◎ エンジンは `CompanyInput` を入力に取るだけ。Provider差し替えで対応。エンジン無改修 |
| 企業分析AI | Provider実装の一種。出力は同じ `CompanyInput` | ◎ |
| 内定者データ / 実績学習 | `weights.ts` の重み係数と `caps.ts`・`selectionTier→bar` 変換を、固定テーブルから**較正済みテーブル**へ差し替え。`scoreReadiness` の式は不変 | ◎ 重みを外部化しておけば学習結果の注入点になる |
| 「選考準備度→内定可能性」格上げ | confidence/ラベルのフラグ切り替え。型は不変 | ◎ |

**結論**: `CompanyInput`(入力) と `weights`(係数) を境界として外に出してあるので、**将来の事実ソース・学習結果は全て「エンジンの入力差し替え」で吸収でき、純粋関数本体は無改修**。設計は将来拡張に耐える。

---

## ⑦ 技術的負債になりそうな点（指摘＋改善案）

率直に、リスク順。

1. **【最大】純粋エンジンに自動テストが無い**
   このリポジトリには jest/vitest が無い（QAは tsx スクリプトのみ）。だが本エンジンは「PASSAI CAREER唯一のスコアリングエンジン」。テスト無しは、重み変更やキャップ追加で**サイレントにスコア分布が壊れる**負債に直結する。
   → **改善**: 最低でも `scripts/qa:careerMatching.ts`（tsx）で golden 入力→期待スコアのスナップショットを置く。理想は vitest 導入（純粋関数なので導入コスト最小・依存ゼロでテストできる対象）。`score*` の決定性（同入力→同出力）は必ず固定テストで守る。

2. **AI推定シグナルの不安定性がスコアを揺らす**
   readiness の多くが MVP では `inferred`（AI判断）。実行ごとに値がブレるとユーザーの信頼を損ねる。
   → **改善**: measured-first を徹底。inferred シグナルは温度0＋値域の粗粒度化（例 20刻み）で安定化。confidence を必ず表示し「推測由来」を隠さない。

3. **companyBar(選考ティア)が未較正なのに simulation Δ% を出す**
   絶対%のΔは過信を招く。
   → **改善**: シミュレーションの主表示は**順位変動（A社 3位→1位）**にし、%Δは副次・注記付き。較正前は「相対的な動き」を主役にする。

4. **6機能ストレージへの密結合**
   matching は6つの `*Storage` を読む。どれかのスキーマが変わると matching がサイレント破損。
   → **改善**: `buildMatchProfile.ts` を**アンチコラプション層**にし、各storageの形依存をここ一箇所に閉じ込める。storage形が変わってもこのアダプタだけ直せばよい。

5. **永続データのスキーマ進化**
   `careerMatchingResults` の形が今後も変わる。score_contract の教訓（cache guard は型ガードのみ・値域で弾くな）を踏襲しないと、過去データや新出力を誤って弾く。
   → **改善**: 保存物に `schemaVersion` を持たせ、ロード時は**型ガードのみ**（スコア値域チェックを入れない）。版が古ければ「再実行」へ誘導。

6. **重み係数テーブルの肥大化（業界×軸）**
   設定が散らばると config 地獄。
   → **改善**: `weights.ts` 一箇所に型付きテーブルで集約し、未定義業界は明示的デフォルトにフォールバック。将来の学習注入点もここに限定。

7. **受験版 `lib/matching/` と就活版 `lib/careerMatching/` の混同リスク**
   名前が近く、誤 import の温床。
   → **改善**: 就活版は `lib/careerMatching/index.ts` 経由のみ公開し、内部直 import を禁止（lint or レビュー規約）。docsに「別エンジン・共有しない」と明記済み（本書）。

---

## ⑧ 契約チェック（実装時ゲート）
- [ ] AIは小スコア＋根拠＋推測情報のみ。総合/順位/Δ/優先度はサーバ純粋関数（仕様④⑤・score_contract）
- [ ] `score*` 3関数は同入力→同出力（テストで固定）
- [ ] avoidances は減点でなくキャップ、`appliedCaps` で説明可能（仕様②）
- [ ] 3スコア独立計算・同一 `ScoreBreakdown` 型（仕様③）
- [ ] 欠損は present:false で重みから除外、confidence に反映（仕様⑩）
- [ ] 各 item に source(measured/inferred) とrationale（Explainability・事実/推測分離）
- [ ] gaps/simulate は `score*` の再利用のみ・LLM不使用（仕様⑥⑧）
- [ ] 保存物に schemaVersion、ロードは型ガードのみ
- [ ] 全AI呼び出しに `logAiUsage()`
