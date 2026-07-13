/**
 * Company Knowledge (Layer 5) — repository interface（P17-A §6.7・契約のみ）。
 *
 * 将来の永続化境界。本 series では production DB へ接続しない
 * （interface + in-memory synthetic 実装のみ）。
 *
 * 禁止（型で表現しない・実装しない）:
 *   - private company research storage への import / 自動昇格 API
 *   - consent なし contribution を read projection へ出す API
 *   - moderation pending を read へ出す API
 *   - contributor identity を返す API
 */

import type {
  AggregatedEvidenceGroup,
  CompanyKnowledgeConsentSnapshot,
  CompanyKnowledgeContribution,
  CompanyMasterRecord,
  ContributionLifecycleAction,
  ContributionModeration,
  ContributionRevision,
  LifecycleAuditEntry,
  LifecycleTransitionResult,
} from '@/types/careerCompanyKnowledge';
import type {
  CompanyKnowledgeProjection,
  ContextSourceResult,
} from '@/types/careerContextSource';

export type CompanyKnowledgeReadProjectionQuery = {
  purpose: string;
  companyId: string;
  displayName: string;
  nowIso: string;
};

export interface CompanyKnowledgeRepository {
  /** company master を登録（synthetic）。 */
  putMaster(record: CompanyMasterRecord): void;
  listMaster(): readonly CompanyMasterRecord[];

  /** contribution を write（moderation pending でも保存はする。read で fail-closed）。 */
  putContribution(c: CompanyKnowledgeContribution): void;
  getContribution(contributionId: string): CompanyKnowledgeContribution | null;
  /** 全 contribution（決定論順・logical excluded を含む）。 */
  listContributions(): readonly CompanyKnowledgeContribution[];

  /** moderation 状態を更新（存在すれば true）。 */
  updateModeration(contributionId: string, moderation: ContributionModeration): boolean;
  /** revoke 相当の logical exclusion（物理削除しない。存在すれば true）。 */
  revoke(contributionId: string): boolean;

  // ── P17-B 追加 ────────────────────────────────────────────────────
  /** lifecycle 遷移を適用（不正遷移は拒否・audit を残す）。 */
  transitionLifecycle(
    contributionId: string,
    action: ContributionLifecycleAction,
    at: string,
  ): LifecycleTransitionResult;
  /** consent snapshot を保存（append-only 志向）。 */
  putConsentSnapshot(snapshot: CompanyKnowledgeConsentSnapshot): void;
  getConsentSnapshot(contributionId: string): CompanyKnowledgeConsentSnapshot | null;
  /** legal hold の設定 / 解除（存在すれば true）。 */
  setLegalHold(contributionId: string, hold: boolean): boolean;
  /** lifecycle transition audit（決定論順）。 */
  listLifecycleAudit(): readonly LifecycleAuditEntry[];
  /** revision 履歴（削除せず履歴化・決定論順）。 */
  listRevisions(nowIso: string): readonly ContributionRevision[];
  /** evidence group（company 単位・purpose filter 前の集約）。 */
  readEvidenceGroups(companyId: string, nowIso: string): readonly AggregatedEvidenceGroup[];

  /** purpose-specific な安全 read projection（fail-closed / provenance / freshness filtering 込み）。 */
  readProjection(
    query: CompanyKnowledgeReadProjectionQuery,
  ): ContextSourceResult<CompanyKnowledgeProjection>;
}
