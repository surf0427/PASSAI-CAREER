// PASSAI 就活版 — 企業マッチング結果を就活相談AI（司令塔）へ渡すための整形ヘルパー。
//
// 役割: 決定的マッチングエンジンの出力（CareerMatchEngineResult / CareerMatchingLog）から、
//       相談AIが「自己理解 × 企業理解」を横断できる軽量スナップショットと、プロンプトへ
//       注入しやすいテキストを作る（純粋関数）。
//   - DOM / localStorage / Supabase / API には触れない（client / server 双方から使う）。
//   - 実際の localStorage 読み出しは呼び出し側が `loadMatchingLogs()`（app/career/matching/
//     matchingStorage）で行い、その結果を本モジュールに渡す（careerGd/context.ts と同じ分離方針）。
//   - lib/careerMatching/index.ts（純粋スコアリングエンジンの公開エントリ）とは別レイヤーの
//     「連携用整形」なので、index からは再エクスポートせず本ファイルを直接 import する。
//
// 使用例（相談AI page / client）:
//   import { loadMatchingLogs } from '@/app/career/matching/matchingStorage';
//   import { buildLatestMatchingConsultationSnapshots } from '@/lib/careerMatching/consultationContext';
//   const snaps = buildLatestMatchingConsultationSnapshots(loadMatchingLogs(), 2);

import type { CareerMatchingLog } from '@/types/careerMatching';
import type { CareerMatchEngineResult, CompanyScore } from '@/lib/careerMatching';
// P4-B: str / round100 を共通 util へ集約（round100 は careerGd.clamp100 と同一実装。出力 byte 一致）。
import { str, round100 } from '@/lib/careerMemory/summaryUtils';

// 相談AIへ渡す軽量スナップショット（マッチング1実行分を要約）。
// 全量（企業ごとの内訳・ロードマップ・シミュレーション）は載せず、司令塔が
// 「軸との一致/ズレ」「次アクション」を語れる最小限に圧縮する。
export type MatchingConsultationSnapshot = {
  createdAt: string;
  careerType: string; // 例:「主体的に周囲を巻き込む推進タイプ」
  recommendedIndustries: string[];
  recommendedJobs: string[];
  developmentAreas: string[]; // 伸びしろ・弱点
  nextSteps: string[]; // マッチング結果として提示された次アクション
  topCompanies: Array<{
    company: string;
    matchScore: number; // マッチ度 0〜100
    readinessScore: number; // 選考準備度 0〜100
    matchReasons: string[]; // 相性理由・希望条件との一致点
    attentionPoints: string[]; // 注意点・希望条件とのズレ
    avoidanceHits: string[]; // 避けたい条件に該当した点（矛盾検知用）
  }>;
};

function strList(value: unknown, max = 6): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, max);
}

// CompanyScore 1 社 → スナップショットの topCompanies 1 要素へ圧縮。
function compressCompany(c: CompanyScore): MatchingConsultationSnapshot['topCompanies'][number] {
  return {
    company: str(c.company),
    matchScore: round100(c.match?.total),
    readinessScore: round100(c.readiness?.total),
    matchReasons: strList(c.matchReasons, 3),
    attentionPoints: strList(c.attentionPoints, 3),
    avoidanceHits: Array.isArray(c.appliedCaps)
      ? c.appliedCaps
          .map((cap) => str(cap?.label))
          .filter(Boolean)
          .slice(0, 3)
      : [],
  };
}

// マッチングエンジン結果 1 件 → 相談AI スナップショット。旧スキーマ・欠損に耐える。
export function buildMatchingConsultationSnapshot(
  log: CareerMatchingLog | null | undefined,
): MatchingConsultationSnapshot | null {
  if (!log || typeof log !== 'object') return null;
  const result: Partial<CareerMatchEngineResult> = (log.result ?? {}) as CareerMatchEngineResult;
  const companies = Array.isArray(result.companies) ? result.companies : [];
  // マッチ度の高い順に上位3社だけを載せる（トークン肥大を避ける）。
  const topCompanies = [...companies]
    .sort((a, b) => round100(b.match?.total) - round100(a.match?.total))
    .slice(0, 3)
    .map(compressCompany)
    .filter((c) => c.company !== '');

  const snapshot: MatchingConsultationSnapshot = {
    createdAt: str(log.createdAt),
    careerType: str(result.careerType),
    recommendedIndustries: strList(result.recommendedIndustries, 5),
    recommendedJobs: strList(result.recommendedJobs, 5),
    developmentAreas: strList(result.developmentAreas, 4),
    nextSteps: strList(result.nextSteps, 4),
    topCompanies,
  };

  // 実質的に中身が無ければ無効扱い（プロンプトに空ブロックを出さない）。
  const hasContent =
    snapshot.careerType !== '' ||
    snapshot.recommendedIndustries.length > 0 ||
    snapshot.recommendedJobs.length > 0 ||
    snapshot.developmentAreas.length > 0 ||
    snapshot.topCompanies.length > 0;
  return hasContent ? snapshot : null;
}

// 複数ログ（最新が先頭）→ 最新 N 件の相談用スナップショット。
export function buildLatestMatchingConsultationSnapshots(
  logs: CareerMatchingLog[] | null | undefined,
  limit = 2,
): MatchingConsultationSnapshot[] {
  if (!logs || logs.length === 0) return [];
  return logs
    .slice(0, Math.max(1, limit))
    .map((l) => buildMatchingConsultationSnapshot(l))
    .filter((s): s is MatchingConsultationSnapshot => s !== null);
}

// API 側で受け取ったスナップショット（unknown）を防御的に正規化する。
// クライアントが送った MatchingConsultationSnapshot を検証してから prompt に使う用途。
export function normalizeMatchingConsultationSnapshot(
  raw: unknown,
): MatchingConsultationSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const topCompaniesRaw = Array.isArray(r.topCompanies) ? r.topCompanies : [];
  const topCompanies = topCompaniesRaw
    .map((c) => {
      if (!c || typeof c !== 'object') return null;
      const cr = c as Record<string, unknown>;
      const company = str(cr.company);
      if (!company) return null;
      return {
        company,
        matchScore: round100(cr.matchScore),
        readinessScore: round100(cr.readinessScore),
        matchReasons: strList(cr.matchReasons, 3),
        attentionPoints: strList(cr.attentionPoints, 3),
        avoidanceHits: strList(cr.avoidanceHits, 3),
      };
    })
    .filter((c): c is MatchingConsultationSnapshot['topCompanies'][number] => c !== null)
    .slice(0, 3);

  const snapshot: MatchingConsultationSnapshot = {
    createdAt: str(r.createdAt),
    careerType: str(r.careerType),
    recommendedIndustries: strList(r.recommendedIndustries, 5),
    recommendedJobs: strList(r.recommendedJobs, 5),
    developmentAreas: strList(r.developmentAreas, 4),
    nextSteps: strList(r.nextSteps, 4),
    topCompanies,
  };

  const hasContent =
    snapshot.careerType !== '' ||
    snapshot.recommendedIndustries.length > 0 ||
    snapshot.recommendedJobs.length > 0 ||
    snapshot.developmentAreas.length > 0 ||
    snapshot.topCompanies.length > 0;
  return hasContent ? snapshot : null;
}

// スナップショット配列 → 相談AI プロンプト用テキストブロック。空なら空文字。
export function formatMatchingConsultationForPrompt(
  snapshots: MatchingConsultationSnapshot[] | null | undefined,
): string {
  if (!snapshots || snapshots.length === 0) return '';
  const blocks = snapshots.map((s, i) => {
    const head = `■ マッチング${snapshots.length > 1 ? ` ${i + 1}` : ''}${
      s.createdAt ? `（${s.createdAt.slice(0, 10)}）` : ''
    }`;
    const lines = [head];
    if (s.careerType) lines.push(`- タイプ: ${s.careerType}`);
    if (s.recommendedIndustries.length > 0) {
      lines.push(`- 向いている業界: ${s.recommendedIndustries.join('、')}`);
    }
    if (s.recommendedJobs.length > 0) {
      lines.push(`- 向いている職種: ${s.recommendedJobs.join('、')}`);
    }
    if (s.developmentAreas.length > 0) {
      lines.push(`- 伸びしろ・課題: ${s.developmentAreas.join('、')}`);
    }
    if (s.nextSteps.length > 0) {
      lines.push(`- マッチングが示した次の一歩: ${s.nextSteps.join('、')}`);
    }
    s.topCompanies.forEach((c) => {
      const parts = [`  ・${c.company}（マッチ度${c.matchScore}／選考準備度${c.readinessScore}）`];
      if (c.matchReasons.length > 0) parts.push(`合う点: ${c.matchReasons.join('、')}`);
      if (c.attentionPoints.length > 0) parts.push(`注意点: ${c.attentionPoints.join('、')}`);
      if (c.avoidanceHits.length > 0) parts.push(`避けたい条件に該当: ${c.avoidanceHits.join('、')}`);
      lines.push(parts.join(' / '));
    });
    return lines.join('\n');
  });
  return [
    '# 直近の企業マッチングAIの結果（自己理解 × 企業理解の接続材料）',
    ...blocks,
    '',
    'マッチングのスコアは本人の入力データからの決定的な試算であり、内定可能性の保証ではない。',
    '企業選び・志望動機・就活軸の相談では、この結果と就活軸/自己分析を突き合わせ、',
    '「合う点」「ズレている点（特に避けたい条件への該当）」を具体的に指摘する材料として使う。',
    'ここに無い企業の事実（事業内容・待遇・選考フロー等）は断定しない。',
  ].join('\n');
}
