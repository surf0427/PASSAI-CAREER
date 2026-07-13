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
  CompanyKnowledgeContribution,
  CompanyMasterRecord,
  ContributionModeration,
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

  /** purpose-specific な安全 read projection（fail-closed / provenance / freshness filtering 込み）。 */
  readProjection(
    query: CompanyKnowledgeReadProjectionQuery,
  ): ContextSourceResult<CompanyKnowledgeProjection>;
}
