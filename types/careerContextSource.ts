/**
 * Data Spine — Shared Context Source Boundary（P17-A）。
 *
 * 位置づけ（production 非接続・offline foundation）:
 *   Layer 2 Personal Memory / Layer 4 Aggregated Insight / Layer 5 Company Knowledge を、
 *   将来 Context Orchestrator（純関数）の **上流** で読み込むための **共通結果契約**。
 *   本ファイルは型のみ（repo 規約: 型は types/）。loader ロジックは lib/careerContextLoaders/*。
 *
 * 設計原則（P17-A §3-4）:
 *   - `available` だけが data / provenance / confidence / freshness / privacy / usage を持つ。
 *   - `available` 以外の status は **data を持てない**（型で禁止）。
 *   - unknown / unavailable を negative evidence として render できない型にする
 *     （empty と unavailable を絶対に混同しない）。
 *   - reason は自由文字列ではなく union で制限する。
 *   - projection は境界の安全表示用 field のみ（user_id / 本文 / raw count / 原本を含めない）。
 *
 * 非目標（P17-A §11）: production 接続 / Supabase / prompt 投入 / Orchestrator 改変。
 */

// ── 分類軸 ──────────────────────────────────────────────────────────
/** projection の privacy 区分（誤用防止のため型で保持）。 */
export type PrivacyClassification =
  | 'personal_owner_scoped' // L2: 本人のみ
  | 'anonymous_aggregate' // L4: k>=閾値・匿名一般傾向
  | 'shared_company_knowledge'; // L5: moderated・explicit-share 済

/** projection の利用規制（prompt 側の扱いを型で固定）。 */
export type UsageRegime =
  | 'personal_context' // L2: 本人文脈
  | 'reference_only' // L4: 断定・個人評価に使わない
  | 'user_evidence_not_fact'; // L5: 事実保証として扱わない

/** どの Layer 由来かを provenance に明示する。 */
export type ContextSourceLayer =
  | 'personal_memory'
  | 'aggregated_insight'
  | 'company_knowledge';

/** policy 値の確定状態（法務未確定は PROVISIONAL のまま運ぶ）。 */
export type ContextPolicyStatus = 'PROVISIONAL' | 'FIXED';

/** 出典（識別子・secret・原本 key を含めない）。 */
export type SourceProvenance = {
  layer: ContextSourceLayer;
  /** ISO。未確定は null。 */
  generatedAt: string | null;
  /** batch window / observed window の粗い表現（exact timestamp ではない）。 */
  sourceWindow: string | null;
  /** metric / normalization 版など（version mismatch 追跡用）。 */
  calculationVersion: string | null;
  policyStatus: ContextPolicyStatus;
};

/** freshness 分類（stale は prompt 利用不可）。 */
export type FreshnessClassification = 'fresh' | 'aging' | 'stale' | 'unknown';

export type FreshnessInfo = {
  generatedAt: string | null; // ISO
  expiresAt: string | null; // ISO
  /** L5 evidence の観測時期（必須運用だが型は null 許容で防御）。 */
  observedPeriod: string | null;
  classification: FreshnessClassification;
};

// ── status 別 reason union（自由文字列を許可しない）─────────────────────
/** empty: 対象を確認したが有効 evidence が無い。negative evidence ではない。 */
export type ContextSourceEmptyReason = 'no_evidence' | 'no_eligible_data';
/** unavailable: 取得不能・未確認・unknown。empty と絶対に混同しない。 */
export type ContextSourceUnavailableReason = 'unknown' | 'not_checked' | 'lookup_error';
/** disabled: 未接続 / flag OFF / shadow 限定（正常な fail-closed）。 */
export type ContextSourceDisabledReason = 'not_connected' | 'flag_off' | 'shadow_only';
/** blocked: consent / legal / moderation / privacy による利用禁止。 */
export type ContextSourceBlockedReason = 'consent' | 'legal' | 'moderation' | 'privacy';
/** stale: 鮮度切れ / 不完全 batch。prompt 利用不可。 */
export type ContextSourceStaleReason = 'freshness_expired' | 'incomplete_batch';

/**
 * 全 Layer 共通の Context Source 結果。
 *
 * `available` のみ data を運ぶ（他 status は data フィールド自体を型に持たない）。
 * これにより「unknown / disabled / stale を data として render する」経路が型で塞がれる。
 */
export type ContextSourceResult<T> =
  | {
      status: 'available';
      data: T;
      provenance: SourceProvenance;
      /** 0..1。根拠を伴う信頼度（単一投稿を過大評価しない）。 */
      confidence: number;
      freshness: FreshnessInfo;
      privacy: PrivacyClassification;
      usage: UsageRegime;
    }
  | { status: 'empty'; reason: ContextSourceEmptyReason }
  | { status: 'unavailable'; reason: ContextSourceUnavailableReason }
  | { status: 'disabled'; reason: ContextSourceDisabledReason }
  | { status: 'blocked'; reason: ContextSourceBlockedReason }
  | { status: 'stale'; reason: ContextSourceStaleReason };

/** available のみ絞り込む type guard（consumer 側の唯一の data 取得口）。 */
export function isContextSourceAvailable<T>(
  r: ContextSourceResult<T>,
): r is Extract<ContextSourceResult<T>, { status: 'available' }> {
  return r.status === 'available';
}

// ── Layer 4 境界 projection（安全表示用のみ）─────────────────────────────
/**
 * Aggregated Insight の境界 projection。
 * 含めない: user_id / raw event id / 本文 / exact raw cohort count / 原本。
 * 生 count は出さず sampleSizeBucket（'50–99' 等）で表現する。
 */
export type AggregatedInsightProjection = {
  metricKey: string;
  feature: string;
  /** renderer 済みの一般傾向文（数値の生表示はしない）。 */
  displayText: string;
  disclaimerKey: string;
  /** 生 count ではなく bucket。 */
  sampleSizeBucket: string;
  generatedAt: string;
  expiresAt: string;
  provenance: SourceProvenance;
};

// ── Layer 5 境界 projection（安全表示用のみ）─────────────────────────────
/** evidence が公式か体験談か（ユーザー体験を企業の確定事実へ変換しない）。 */
export type CompanyKnowledgeEvidenceKind =
  | 'official'
  | 'company_provided'
  | 'user_experience'
  | 'inferred_summary';

/** 複数投稿の裏付け状態（単一投稿を general trend として表示しない）。 */
export type CompanyKnowledgeCorroboration =
  | 'single_report'
  | 'multiple_reports'
  | 'independent_corroboration'
  | 'conflicting';

export type CompanyKnowledgeEvidenceSummary = {
  /** es_question / interview_question / selection_flow / briefing_note / desired_candidate_profile など。 */
  contentCategory: string;
  /** 短い構造化要約（本文全文・PII・投稿者情報を含めない）。 */
  summary: string;
  evidenceKind: CompanyKnowledgeEvidenceKind;
  /** 観測時期（必須運用）。 */
  observedPeriod: string;
  freshness: FreshnessClassification;
  /** 0..1。 */
  confidence: number;
  /** 相反 evidence を隠さず保持する。 */
  conflicting: boolean;
};

/**
 * Company Knowledge の境界 projection。
 * 含めない: contributor 氏名 / email / 大学 / 応募 ID / auth user id / 原本本文 / private research 型。
 */
export type CompanyKnowledgeProjection = {
  /** canonical company id（ambiguous は projection されない）。 */
  companyId: string;
  displayName: string;
  evidence: readonly CompanyKnowledgeEvidenceSummary[];
  corroboration: CompanyKnowledgeCorroboration;
  provenance: SourceProvenance;
};
