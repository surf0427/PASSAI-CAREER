// PASSAI CAREER — 所有者名前空間の対象になる canonical storage キー一覧（単一の宣言）。
//
// ここに列挙したキーだけが `careerStorageKey()` を通り、所有者ごとに分離される。
// 新しい career の localStorage キーを足したら **必ずここへ追加する**
// （scripts/career-owner-isolation-qa.ts が storage module 側の実キーと突き合わせ、
//  取りこぼしを検出する）。
//
// ★ 意図的に含めないもの:
//   - 'supabaseBackfill'（lib/repository/backfillFlag.ts）
//     値の内部が既に userId 別で、かつ「この端末に過去どの account が居たか」の
//     所有証明として legacyClaim が読むため、**共有のまま**でなければならない。
//   - 'careerStorageOwner'（所有者 pointer 自身）。
//   - 'careerSelfAnalysisUpdateDraft:<scope>'（既に userId 由来 scope でキー分離済み）。

export const CAREER_OWNED_STORAGE_KEYS = [
  // 単一レコード系（プロフィール / 活動 / 就活軸）
  'careerBasicFormData',
  'careerActivityData',
  'careerValues',
  // 自己分析
  'careerSelfAnalysisLogs',
  'careerSelfPRs',
  'careerAnalyzeState',
  // ES（正式ログ + 作成中 draft）
  'careerEsLogs',
  'careerEsDrafts',
  // 面接（進行中セッション / 結果 / 前段 draft）
  'careerInterviewSessions',
  'careerInterviewResults',
  'careerInterviewTargetDraft',
  // プレゼン（同上）
  'careerPresentationSessions',
  'careerPresentationResults',
  'careerPresentationTargetDraft',
  // 企業マッチング / 企業研究 / 就活相談
  'careerMatchingResults',
  'careerCompanyResearchLogs',
  'careerConsultationLogs',
  // GD（ソロ セッション/結果 + 複数人ログの端末 cache）
  'careerGdSessions',
  'careerGdResults',
  'careerGdRoomLogs',
  // 企業 Data Spine（応募管理 / 端末ディレクトリ）
  'careerCompanyApplications',
  'careerCompanyDirectory',
] as const;

export type CareerOwnedStorageKey = (typeof CAREER_OWNED_STORAGE_KEYS)[number];

/**
 * legacy 移行（lib/careerStorage/legacyClaim.ts）から **除外する**キー。
 *
 * 'careerEsDrafts' は record 自体が既に owner 概念を持つ（CareerEsDraft.ownerId。
 * guest draft は ownerId=null）。読み出し `loadEsDrafts(userId)` が ownerId で絞るため、
 * guest が作った draft は **名前空間の導入前から** member には見えていない。
 * これを member 名前空間へ移すと、ownerId=null のまま member 側へ入って
 * どちらからも見えなくなる（＝ログアウト時に見えていた draft が消える）ので移さない。
 * 名前空間による隔離（読み書き先の分離）は他キーと同様に効く。
 */
export const CAREER_LEGACY_CLAIM_EXCLUDED_KEYS: readonly string[] = ['careerEsDrafts'];
