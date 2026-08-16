// PASSAI 就活版 — マイページ（就活ダッシュボード）の集約ロジック。
//
// 役割:
//   各 career 機能の localStorage helper（app/career/*/xxxStorage.ts）を読み取り、
//   進捗サマリー・実績集計・最近のアウトプット・次アクションを 1 つの純粋関数で組み立てる。
//   保存は一切行わない（読み取り専用の派生）。専用の保存キーは作らない
//   （source of truth は各機能の既存ログのまま。二重管理を避ける）。
//
// 方針:
//   - localStorage canonical。ここでは書き込み / Supabase には一切触れない。
//   - SSR/hydration 安全化は呼び出し側（page.tsx の mount ガード）が担保する。
//     各 loader は safeStorage 経由で SSR ガード済みだが、本関数は mount 後にだけ呼ぶ。
//   - 受験版のデータ・型・文言は一切参照しない（career プレフィックスの helper のみ）。

import type { CareerProfile } from '@/types/careerProfile';

import { loadBasicInfo } from '@/app/career/profile/profileStorage';
import { loadActivityData, hasAnyActivity } from '@/app/career/activity/activityStorage';
import {
  loadCareerValues,
  isCareerValuesEmpty,
} from '@/app/career/values/careerValuesStorage';
import { loadSelfAnalysisLogs } from '@/app/career/self-analysis/selfAnalysisStorage';
import { loadMatchingLogs } from '@/app/career/matching/matchingStorage';
import { loadEsLogs } from '@/app/career/es/esStorage';
import {
  loadInterviewResults,
  getInProgressInterviewSession,
} from '@/app/career/interview/interviewStorage';
import { loadCompanyResearchLogs } from '@/app/career/company-research/companyResearchStorage';
import {
  loadPresentationResults,
  getInProgressPresentationSession,
} from '@/app/career/presentation/presentationStorage';
import {
  loadGdResults,
  getInProgressGdSession,
} from '@/app/career/gd/gdStorage';
import { loadGdRoomLogs } from '@/app/career/gd/gdRoomLogStorage';
import { loadConsultationThreads } from '@/app/career/consultation/consultationStorage';
import { isCareerCompanyMatchingUiEnabled } from '@/lib/careerMatchingGate/flag';

// ── 企業マッチング公開ゲート ──────────────────────────────────────────
// 初回リリースでは企業マッチングを出さない（flag OFF が既定）。
//
// ★ データは消さない。`loadMatchingLogs()` はこれまでどおり読み、過去に企業マッチングを
//   実行済みのユーザーの localStorage / Supabase 上の結果は一切書き換えない。
//   OFF の間ゲートするのは「/career/matching へ遷移させる導線」だけ:
//     1. 進捗サマリー行（件数 + link）
//     2. 最近のアウトプット（href が matching route）
//     3. 次アクション CTA「企業マッチングを試す」（＝新規実行への誘導）
//   achievements.matching は tile として描画されていない集計値なので実数のまま残す
//   （導線を持たず露出もしないため、flag ON 復帰時に数字が飛ばない）。
//   isEmpty も実データ基準のまま（履歴を持つユーザーを空扱いに退行させない）。
const MATCHING_UI_ENABLED = isCareerCompanyMatchingUiEnabled();

// ── 公開型 ───────────────────────────────────────────────────────────

export type MypageFeatureKey =
  | 'basic'
  | 'activity'
  | 'values'
  | 'selfAnalysis'
  | 'matching'
  | 'es'
  | 'interview'
  | 'companyResearch'
  | 'presentation'
  | 'gd'
  | 'consultation';

export type ProgressState = 'done' | 'in_progress' | 'has_history' | 'empty';

export type ProgressItem = {
  key: MypageFeatureKey;
  label: string;
  href: string;
  state: ProgressState;
  count: number; // ログ系のみ。単発ドキュメント（基本情報/活動/軸）は 0。
  latest: string | null; // ISO 文字列 or null
  statusLabel: string; // 就活版の日本語ステータス
};

export type ScoreStat = {
  key: string;
  label: string;
  count: number;
  average: number; // 0〜100（四捨五入）
  latest: number; // 最新 1 件のスコア（0〜100）
};

export type AchievementStats = {
  es: number;
  interview: number;
  presentation: number;
  gdSolo: number;
  gdMulti: number;
  companyResearch: number;
  consultation: number;
  selfAnalysis: number;
  matching: number;
  lastFeatureLabel: string | null;
  lastUpdated: string | null;
  scores: ScoreStat[];
};

export type RecentOutput = {
  id: string;
  title: string;
  type: string;
  date: string; // ISO 文字列
  href: string;
  description: string;
};

export type NextAction = {
  key: MypageFeatureKey;
  title: string;
  description: string;
  href: string;
  cta: string;
};

export type MypageSummary = {
  profile: CareerProfile | null;
  isEmpty: boolean;
  progress: ProgressItem[];
  achievements: AchievementStats;
  recent: RecentOutput[];
  nextActions: NextAction[];
};

// ── 小さなヘルパー ───────────────────────────────────────────────────

function snippet(text: string, max = 48): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (t === '') return '';
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

// ISO 文字列の配列から最も新しいものを返す（無ければ null）。
function latestOf(dates: Array<string | undefined | null>): string | null {
  let max: string | null = null;
  for (const d of dates) {
    if (typeof d === 'string' && d && (max === null || d > max)) max = d;
  }
  return max;
}

function average(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sum = nums.reduce((a, b) => a + b, 0);
  return Math.round(sum / nums.length);
}

const INTERVIEW_TYPE_LABEL: Record<string, string> = {
  self_analysis: '自己分析深掘り',
  gakuchika: 'ガクチカ深掘り',
  self_pr: '自己PR深掘り',
  motivation: '志望動機',
  real: '本番想定面接',
  pressure: '圧迫面接',
};

const PRESENTATION_TYPE_LABEL: Record<string, string> = {
  self_pr: '自己PRプレゼン',
  gakuchika: 'ガクチカプレゼン',
  motivation: '志望動機プレゼン',
  company_research: '企業・業界研究プレゼン',
  case: 'ケース課題プレゼン',
  real: '本番選考プレゼン',
};

// ── メイン ───────────────────────────────────────────────────────────

export function buildMypageSummary(): MypageSummary {
  const profile = loadBasicInfo();
  const activity = loadActivityData();
  const values = loadCareerValues();
  const selfAnalysisLogs = loadSelfAnalysisLogs();
  const matchingLogs = loadMatchingLogs();
  const esLogs = loadEsLogs();
  const interviewResults = loadInterviewResults();
  const companyResearchLogs = loadCompanyResearchLogs();
  const presentationResults = loadPresentationResults();
  const gdResults = loadGdResults();
  const gdRoomLogs = loadGdRoomLogs();
  const consultationThreads = loadConsultationThreads();

  const activityFilled = hasAnyActivity(activity);
  const valuesFilled = values !== null && !isCareerValuesEmpty(values);

  const inProgressInterview = getInProgressInterviewSession() !== null;
  const inProgressPresentation = getInProgressPresentationSession() !== null;
  const inProgressGd = getInProgressGdSession() !== null;

  // ── 進捗サマリー ──────────────────────────────────────────────────
  const progress: ProgressItem[] = [
    docItem('basic', '基本情報', '/career/profile', profile !== null, null, {
      done: '入力済み',
      empty: '未入力',
    }),
    docItem(
      'activity',
      '活動整理',
      '/career/activity',
      activityFilled,
      activity?.updatedAt ?? null,
      { done: '入力済み', empty: '未入力' },
    ),
    docItem(
      'values',
      '就活軸整理',
      '/career/values',
      valuesFilled,
      values?.updatedAt ?? null,
      { done: '整理済み', empty: '未整理' },
    ),
    logItem(
      'selfAnalysis',
      '自己分析',
      '/career/self-analysis',
      selfAnalysisLogs.length,
      latestOf(selfAnalysisLogs.map((l) => l.createdAt)),
      false,
    ),
    // 企業マッチング: flag OFF の間は行ごと出さない（0 件表示でも link が残るため）。
    ...(MATCHING_UI_ENABLED
      ? [
          logItem(
            'matching',
            '企業マッチング',
            '/career/matching',
            matchingLogs.length,
            latestOf(matchingLogs.map((l) => l.createdAt)),
            false,
          ),
        ]
      : []),
    logItem(
      'es',
      'ES作成',
      '/career/es',
      esLogs.length,
      latestOf(esLogs.map((l) => l.createdAt)),
      false,
    ),
    logItem(
      'interview',
      '面接練習',
      '/career/interview',
      interviewResults.length,
      latestOf(interviewResults.map((l) => l.createdAt)),
      inProgressInterview,
    ),
    logItem(
      'companyResearch',
      '企業研究',
      '/career/company-research',
      companyResearchLogs.length,
      latestOf(companyResearchLogs.map((l) => l.updatedAt || l.createdAt)),
      false,
    ),
    logItem(
      'presentation',
      'プレゼン対策',
      '/career/presentation',
      presentationResults.length,
      latestOf(presentationResults.map((l) => l.createdAt)),
      inProgressPresentation,
    ),
    logItem(
      'gd',
      'GD練習',
      '/career/gd',
      gdResults.length + gdRoomLogs.length,
      latestOf([
        ...gdResults.map((l) => l.createdAt),
        ...gdRoomLogs.map((l) => l.createdAt),
      ]),
      inProgressGd,
    ),
    logItem(
      'consultation',
      '就活相談AI',
      '/career/consultation',
      consultationThreads.length,
      latestOf(consultationThreads.map((t) => t.updatedAt)),
      false,
    ),
  ];

  // ── 実績集計 ──────────────────────────────────────────────────────
  // スコア平均は「型として数値が明確なもの」だけを対象にする（不明瞭な平均化はしない）。
  const scores: ScoreStat[] = [];

  if (presentationResults.length > 0) {
    const vals = presentationResults.map((r) => r.result.totalScore);
    scores.push({
      key: 'presentation',
      label: 'プレゼン',
      count: presentationResults.length,
      average: average(vals),
      latest: newestScore(
        presentationResults.map((r) => ({ date: r.createdAt, score: r.result.totalScore })),
      ),
    });
  }
  if (companyResearchLogs.length > 0) {
    const vals = companyResearchLogs.map((l) => l.review.overallScore);
    scores.push({
      key: 'companyResearch',
      label: '企業研究',
      count: companyResearchLogs.length,
      average: average(vals),
      latest: newestScore(
        companyResearchLogs.map((l) => ({
          date: l.updatedAt || l.createdAt,
          score: l.review.overallScore,
        })),
      ),
    });
  }
  const scoredRoomLogs = gdRoomLogs.filter((l) => l.evaluation.scored);
  if (scoredRoomLogs.length > 0) {
    const vals = scoredRoomLogs.map((l) => l.evaluation.overallScore);
    scores.push({
      key: 'gdRoom',
      label: 'GD（複数人）',
      count: scoredRoomLogs.length,
      average: average(vals),
      latest: newestScore(
        scoredRoomLogs.map((l) => ({ date: l.createdAt, score: l.evaluation.overallScore })),
      ),
    });
  }

  // 「最後に利用した機能」= latest を持つ progress の中で最も新しいもの。
  const lastProgress = progress
    .filter((p) => p.latest !== null)
    .sort((a, b) => (b.latest! > a.latest! ? 1 : b.latest! < a.latest! ? -1 : 0))[0];

  const achievements: AchievementStats = {
    es: esLogs.length,
    interview: interviewResults.length,
    presentation: presentationResults.length,
    gdSolo: gdResults.length,
    gdMulti: gdRoomLogs.length,
    companyResearch: companyResearchLogs.length,
    consultation: consultationThreads.length,
    selfAnalysis: selfAnalysisLogs.length,
    matching: matchingLogs.length,
    lastFeatureLabel: lastProgress?.label ?? null,
    lastUpdated: lastProgress?.latest ?? null,
    scores,
  };

  // ── 最近のアウトプット（横断・最大5件） ───────────────────────────
  const recentAll: RecentOutput[] = [
    ...esLogs.map((l) => ({
      id: `es-${l.id}`,
      title: l.companyName?.trim() || snippet(l.question ?? '') || 'ES作成',
      type: 'ES',
      date: l.createdAt,
      href: '/career/es',
      // 新: ユーザーが書いた本文（body / result.answer）を優先。旧: 生成系フィールド。
      description: snippet(
        l.body || l.result.answer || l.result.headline || l.result.gakuchika || l.result.selfPr,
      ),
    })),
    ...interviewResults.map((l) => ({
      id: `interview-${l.id}`,
      title: INTERVIEW_TYPE_LABEL[l.interviewType ?? 'real'] ?? '面接練習',
      type: '面接',
      date: l.createdAt,
      href: '/career/interview',
      description: snippet(l.result.overallComment),
    })),
    ...presentationResults.map((l) => ({
      id: `presentation-${l.id}`,
      title:
        snippet(l.theme, 32) ||
        PRESENTATION_TYPE_LABEL[l.presentationType] ||
        'プレゼン練習',
      type: 'プレゼン',
      date: l.createdAt,
      href: '/career/presentation',
      description: snippet(l.result.overallComment),
    })),
    ...gdResults.map((l) => ({
      id: `gd-${l.id}`,
      title: snippet(l.theme.title, 32) || 'GD練習',
      type: 'GD',
      date: l.createdAt,
      href: '/career/gd',
      description: snippet(l.overallSummary),
    })),
    ...gdRoomLogs.map((l) => ({
      id: `gdroom-${l.id}`,
      title: snippet(l.theme.title, 32) || 'GD（複数人）',
      type: 'GD',
      date: l.createdAt,
      href: '/career/gd',
      description: snippet(l.evaluation.overallComment),
    })),
    ...companyResearchLogs.map((l) => ({
      id: `company-${l.id}`,
      title: l.companyName?.trim() || '企業研究',
      type: '企業研究',
      date: l.updatedAt || l.createdAt,
      href: '/career/company-research',
      description: snippet(l.review.overallComment),
    })),
    ...selfAnalysisLogs.map((l) => ({
      id: `self-${l.id}`,
      title: snippet(l.result.summary, 32) || '自己分析',
      type: '自己分析',
      date: l.createdAt,
      href: '/career/self-analysis',
      description: snippet(l.result.careerDirection || l.result.summary),
    })),
    // 企業マッチング結果: href が matching route なので flag OFF の間は履歴に出さない
    //（保存済みデータ自体は残る。flag ON で従来どおり再表示される）。
    ...(MATCHING_UI_ENABLED
      ? matchingLogs.map((l) => ({
          id: `matching-${l.id}`,
          title: '企業マッチング結果',
          type: 'マッチング',
          date: l.createdAt,
          href: '/career/matching',
          description: snippet(l.userInput),
        }))
      : []),
    ...consultationThreads
      .filter((t) => t.messages.length > 0)
      .map((t) => ({
        id: `consult-${t.id}`,
        title: snippet(t.title, 32) || '就活相談',
        type: '相談',
        date: t.updatedAt,
        href: '/career/consultation',
        description: snippet(t.messages[t.messages.length - 1]?.content ?? ''),
      })),
  ];

  const recent = recentAll
    .filter((r) => typeof r.date === 'string' && r.date !== '')
    .sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0))
    .slice(0, 5);

  // ── 次にやるべきこと（deterministic・最大3件） ─────────────────────
  const nextActions = buildNextActions({
    hasProfile: profile !== null,
    activityFilled,
    valuesFilled,
    selfAnalysis: selfAnalysisLogs.length,
    matching: matchingLogs.length,
    matchingEnabled: MATCHING_UI_ENABLED,
    companyResearch: companyResearchLogs.length,
    es: esLogs.length,
    interview: interviewResults.length,
    gd: gdResults.length + gdRoomLogs.length,
  });

  const isEmpty =
    profile === null &&
    !activityFilled &&
    !valuesFilled &&
    selfAnalysisLogs.length === 0 &&
    matchingLogs.length === 0 &&
    esLogs.length === 0 &&
    interviewResults.length === 0 &&
    companyResearchLogs.length === 0 &&
    presentationResults.length === 0 &&
    gdResults.length === 0 &&
    gdRoomLogs.length === 0 &&
    consultationThreads.length === 0;

  return { profile, isEmpty, progress, achievements, recent, nextActions };
}

// ── 内部ビルダー ─────────────────────────────────────────────────────

function docItem(
  key: MypageFeatureKey,
  label: string,
  href: string,
  filled: boolean,
  latest: string | null,
  labels: { done: string; empty: string },
): ProgressItem {
  return {
    key,
    label,
    href,
    state: filled ? 'done' : 'empty',
    count: 0,
    latest: filled ? latest : null,
    statusLabel: filled ? labels.done : labels.empty,
  };
}

function logItem(
  key: MypageFeatureKey,
  label: string,
  href: string,
  count: number,
  latest: string | null,
  inProgress: boolean,
): ProgressItem {
  let state: ProgressState;
  let statusLabel: string;
  if (count > 0) {
    state = 'has_history';
    statusLabel = `${count}件の履歴`;
  } else if (inProgress) {
    state = 'in_progress';
    statusLabel = '進行中';
  } else {
    state = 'empty';
    statusLabel = '未着手';
  }
  return { key, label, href, state, count, latest, statusLabel };
}

function newestScore(items: Array<{ date: string; score: number }>): number {
  const sorted = [...items].sort((a, b) =>
    b.date > a.date ? 1 : b.date < a.date ? -1 : 0,
  );
  return sorted[0]?.score ?? 0;
}

type NextActionCtx = {
  hasProfile: boolean;
  activityFilled: boolean;
  valuesFilled: boolean;
  selfAnalysis: number;
  matching: number;
  /** 企業マッチング導線の公開可否。false なら matching CTA を候補に入れない。 */
  matchingEnabled: boolean;
  companyResearch: number;
  es: number;
  interview: number;
  gd: number;
};

// 優先順位順に「未達のもの」を拾い、最大3件返す。すべて達成済みなら相談AIへ誘導する。
function buildNextActions(ctx: NextActionCtx): NextAction[] {
  const defs: Array<{ done: boolean; action: NextAction }> = [
    {
      done: ctx.hasProfile,
      action: {
        key: 'basic',
        title: '基本情報を登録する',
        description:
          '大学・学年などの基本情報を登録すると、AIの提案がぐっと具体的になります。',
        href: '/career/profile',
        cta: '基本情報を入力',
      },
    },
    {
      done: ctx.activityFilled,
      action: {
        key: 'activity',
        title: '活動を整理する',
        description:
          '学生時代の経験を整理すると、ES・面接・企業研究の精度が上がります。',
        href: '/career/activity',
        cta: '活動整理へ',
      },
    },
    {
      done: ctx.valuesFilled,
      action: {
        key: 'values',
        title: '就活軸を整理する',
        description:
          '重視する条件や働き方を整理して、企業選びの軸を言語化しましょう。',
        href: '/career/values',
        cta: '就活軸整理へ',
      },
    },
    {
      done: ctx.selfAnalysis > 0,
      action: {
        key: 'selfAnalysis',
        title: '自己分析を進める',
        description: 'AIとの壁打ちで、自分の強みや価値観を深掘りしましょう。',
        href: '/career/self-analysis',
        cta: '自己分析へ',
      },
    },
    // 企業マッチングは初回リリース対象外。OFF の間は候補ごと外す。
    // ★ done:false のまま残すと「未達」として CTA が前面に出てしまうため、
    //   件数ではなく flag で候補から除外するのが正しい（done:true 扱いにもしない）。
    ...(ctx.matchingEnabled
      ? [
          {
            done: ctx.matching > 0,
            action: {
              key: 'matching' as const,
              title: '企業マッチングを試す',
              description:
                'これまでの入力をもとに、相性の良い企業の傾向を確認できます。',
              href: '/career/matching',
              cta: 'マッチングへ',
            },
          },
        ]
      : []),
    {
      done: ctx.companyResearch > 0,
      action: {
        key: 'companyResearch',
        title: '企業研究をAIに添削してもらう',
        description:
          '調べた企業研究メモの不足や思い込みを、AIが家庭教師として指摘します。',
        href: '/career/company-research',
        cta: '企業研究へ',
      },
    },
    {
      done: ctx.es > 0,
      action: {
        key: 'es',
        title: 'ESを作成する',
        description:
          'ガクチカ・自己PR・志望動機のESを、AIのサポートで書き上げましょう。',
        href: '/career/es',
        cta: 'ES作成へ',
      },
    },
    {
      done: ctx.interview > 0,
      action: {
        key: 'interview',
        title: '面接練習をする',
        description:
          '面接官AIと、質問→回答→深掘りのターン形式で本番に備えましょう。',
        href: '/career/interview',
        cta: '面接練習へ',
      },
    },
    {
      done: ctx.gd > 0,
      action: {
        key: 'gd',
        title: 'GD練習をする',
        description:
          'AI参加者とのグループディスカッションを、選考目線で評価してもらえます。',
        href: '/career/gd',
        cta: 'GD練習へ',
      },
    },
  ];

  const pending = defs.filter((d) => !d.done).map((d) => d.action);
  if (pending.length > 0) return pending.slice(0, 3);

  // すべて着手済み → 総合相談へ。
  return [
    {
      key: 'consultation',
      title: '就活相談AIに相談する',
      description:
        'ひと通り揃いました。ここまでの整理をもとに、次の一手をAIと相談しましょう。',
      href: '/career/consultation',
      cta: '相談する',
    },
  ];
}
