/**
 * PASSAI CAREER — マイページ × User Data Spine 接続 QA（常設 harness）。
 *
 * 固定する契約:
 *   M1  read path      : マイページの view は Layer 1 bundle だけから決定的に導かれる。
 *   M2  same projection: 表示に使う Layer 2 section は server と **同一 builder** の出力である。
 *   M3  no dummy       : 実 canonical data が無ければ行を作らない（ダミー insight を生成しない）。
 *   M4  write path     : 志望条件の編集が canonical profile へ非破壊マージされる。
 *   M5  prompt reach   : マイページで保存した値が Layer 1 prompt / Layer 2 prompt へ到達する。
 *   M6  no 2nd store   : マイページが独自 storage / 独自 table / 独自 formatter を持たない。
 *   M7  boundaries     : guest/member 境界・Company Data Spine 非混入・AI call 非新設。
 *
 * 純粋 static + 純関数のみ（Supabase / network / env 非依存）。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  EMPTY_CAREER_SOURCE_BUNDLE,
  type CareerSourceBundle,
} from '@/lib/careerSourceData/types';
import { projectSectionFromSource } from '@/lib/careerMemory/persistence/sourceProjection';
import { renderPersonalMemoryForPurpose } from '@/lib/careerMemory/personalMemoryPromptContext';
import { buildCareerContextForPurpose } from '@/lib/careerContext/orchestrator';
import { buildCareerAiContext } from '@/lib/careerAi';
import type { CareerContextPurpose } from '@/lib/careerContext/purpose';
import type { CareerProfile } from '@/types/careerProfile';
import type { CareerSelfAnalysisLog } from '@/types/careerSelfAnalysis';
import type { CareerActivity } from '@/types/careerActivity';
import type { CareerValues } from '@/types/careerValues';
import {
  buildMypageSpineView,
  readCareerAspiration,
  applyCareerAspiration,
  isCareerAspirationEmpty,
  EMPTY_CAREER_ASPIRATION,
} from '@/app/career/mypage/mypageDataSpineView';

const ROOT = process.cwd();
const MYPAGE_DIR = join(ROOT, 'app/career/mypage');

let failures = 0;
function check(ok: boolean, label: string, detail = ''): void {
  if (ok) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

// ── fixtures（実データ相当。すべて Layer 1 domain 型） ──────────────────

const PROFILE: CareerProfile = {
  name: 'テスト太郎',
  grade: '3年',
  track: '',
  examTypes: [],
  overallGpa: '',
  graduationYear: '2028年卒',
  preferences: [{ university: 'PASSAI大学', faculty: '経済学部', department: '経済学科' }],
  targetIndustries: ['コンサル', 'IT・通信'],
  targetJobs: ['戦略コンサルタント'],
  targetCompanies: ['ゼータ総研'],
  jobHuntingStatus: '本選考にエントリー中',
  preferredLocations: ['東京'],
};

const ACTIVITY = {
  updatedAt: '2026-08-01T00:00:00.000Z',
  focusedActivities: [{ title: '学園祭実行委員長' }],
  partTimeJobs: [{ title: '塾講師' }],
  hobbies: [{ hobby: '登山' }],
  awards: [{ award: '学内ビジコン優勝' }],
} as unknown as CareerActivity;

const VALUES = {
  selections: {
    priorities: ['成長環境がある'],
    avoidances: ['残業が多い'],
    industries: ['コンサル'],
    jobTypes: ['企画'],
    workStyles: ['リモートワーク中心'],
    companyTypes: ['ベンチャー'],
    careerGoals: ['専門性を高めたい'],
    culturePreferences: ['フラットな組織'],
  },
  notes: {
    priorities: '', avoidances: '', industries: '', jobTypes: '',
    workStyles: '', companyTypes: '', careerGoals: '', culturePreferences: '',
  },
  overallNote: '',
  updatedAt: '2026-08-02T00:00:00.000Z',
} as unknown as CareerValues;

const SELF_LOG = {
  id: 'sa-1',
  createdAt: '2026-08-03T00:00:00.000Z',
  userInput: '',
  result: {
    summary: '課題を構造化して考えるタイプ',
    careerDirection: '課題解決型の職種で専門性を積む',
    strengths: ['構造化思考', '巻き込み力'],
    weaknesses: ['完璧主義'],
    valueKeywords: ['誠実さ'],
    recommendedIndustries: ['コンサル'],
    recommendedJobs: ['戦略コンサルタント'],
    companySelectionCriteria: ['裁量の大きさ'],
    nextActions: ['ケース面接の練習'],
  },
} as unknown as CareerSelfAnalysisLog;

const FULL_BUNDLE: CareerSourceBundle = {
  ...EMPTY_CAREER_SOURCE_BUNDLE,
  profile: PROFILE,
  activity: ACTIVITY,
  values: VALUES,
  selfAnalysisLogs: [SELF_LOG],
};

// ─────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log('=== career-mypage-data-spine-qa ===');

  // ── M1: read path は Layer 1 bundle だけから決定的に導かれる ─────
  console.log('\n[M1] read path / determinism');
  {
    const a = buildMypageSpineView(FULL_BUNDLE);
    const b = buildMypageSpineView(FULL_BUNDLE);
    check(JSON.stringify(a) === JSON.stringify(b), '同一 bundle → 同一 view（決定的）');

    const empty = buildMypageSpineView(EMPTY_CAREER_SOURCE_BUNDLE);
    check(empty.understanding.length === 0, '空 bundle → understanding 0 行');
    check(empty.selfAnalysis === null, '空 bundle → 自己分析 null');
    check(empty.experience.sections.length === 0, '空 bundle → 活動カテゴリ 0');
    check(
      isCareerAspirationEmpty(empty.aspiration),
      '空 bundle → 志望条件は空（EMPTY_CAREER_ASPIRATION 相当）',
    );
    check(
      empty.completeness.every((c) => !c.filled) && empty.completenessDone === 0,
      '空 bundle → 充実度は全項目未入力（ダミー % を作らない）',
    );
    check(
      // fixture は basic / aspiration / values / activity / selfAnalysis の 5 項目のみ充実
      // （es / interview は未着手）。ハードコードした % ではなく実データ由来であることの固定。
      a.completeness.length === 7 && a.completenessDone === 5,
      '充実済み bundle の充実度は実データから決定論算出',
      `${a.completenessDone}/${a.completeness.length}`,
    );
  }

  // ── M2: 表示に使う projection が server と同一 builder ─────────────
  console.log('\n[M2] 表示 projection == Data Spine projection');
  {
    const view = buildMypageSpineView(FULL_BUNDLE);
    for (const key of ['base', 'self_analysis', 'es', 'interview'] as const) {
      const direct = projectSectionFromSource(key, FULL_BUNDLE);
      check(
        direct !== null && view.sectionRevisions[key] === direct.sourceRevision,
        `${key}: view の revision が projectSectionFromSource と一致（別 projection を作っていない）`,
        `${view.sectionRevisions[key]} vs ${direct?.sourceRevision}`,
      );
    }
    // マイページの view module が自前の memory builder を再実装していないこと。
    const src = read('app/career/mypage/mypageDataSpineView.ts');
    check(
      src.includes('projectSectionFromSource'),
      'view module は canonical projection を再利用する',
    );
    check(
      !/computeContentRevision|buildBaseMemorySection\s*\(/.test(src),
      'view module は revision / section builder を再実装しない',
    );
  }

  // ── M3: 実 canonical data 由来のみ（ダミー insight を作らない） ────
  console.log('\n[M3] no dummy insight');
  {
    const view = buildMypageSpineView(FULL_BUNDLE);
    check(view.understanding.every((f) => f.values.length > 0), '値が空の行は生成されない');

    const flat = view.understanding.flatMap((f) => f.values);
    // すべての表示値が fixture（= 実 canonical data）に由来すること。
    const sourceText = JSON.stringify([PROFILE, ACTIVITY, VALUES, SELF_LOG]);
    check(
      flat.every((v) => sourceText.includes(v)),
      'understanding の全値が実 canonical data に存在する（捏造ゼロ）',
      flat.filter((v) => !sourceText.includes(v)).join(','),
    );
    check(
      view.understanding.some((f) => f.key === 'strengths' && f.values.includes('構造化思考')),
      '自己分析の強みが「強み」行へ到達',
    );
    check(
      view.understanding.some((f) => f.key === 'industries' && f.values.includes('コンサル')),
      '志望業界が「関心のある業界」行へ到達',
    );
    // 自己分析は最新 canonical 1 件のみ（過去 revision を並べない）。
    check(
      view.selfAnalysis?.summary === '課題を構造化して考えるタイプ',
      '自己分析は最新 canonical 結果を表示',
    );
    // hidden prompt / system prompt を UI へ出していない。
    const uiFiles = readdirSync(MYPAGE_DIR).filter((f) => f.endsWith('.tsx'));
    for (const f of uiFiles) {
      const src = readFileSync(join(MYPAGE_DIR, f), 'utf8');
      check(
        !/buildCareerSystemPrompt|SYSTEM_PROMPT|personalMemoryContext|<personal_memory>/.test(src),
        `${f}: raw prompt / system prompt を描画しない`,
      );
    }
  }

  // ── M4: canonical write path（非破壊マージ / 空はキー削除） ────────
  console.log('\n[M4] write path');
  {
    const base: CareerProfile = {
      name: '既存太郎',
      grade: '3年',
      track: '',
      examTypes: [],
      preferences: [{ university: 'PASSAI大学', faculty: '経済学部' }],
      graduationYear: '2028年卒',
    };
    const next = applyCareerAspiration(base, {
      ...EMPTY_CAREER_ASPIRATION,
      targetIndustries: ['メーカー', 'メーカー', ' 商社 '],
      jobHuntingStatus: '面接が進行中',
    });
    check(next.name === '既存太郎' && next.graduationYear === '2028年卒', '既存 field を壊さない');
    check(
      next.preferences?.[0]?.university === 'PASSAI大学',
      '大学情報（preferences）を壊さない',
    );
    check(
      JSON.stringify(next.targetIndustries) === JSON.stringify(['メーカー', '商社']),
      '重複除去 + trim（決定的）',
      JSON.stringify(next.targetIndustries),
    );
    check(next.jobHuntingStatus === '面接が進行中', '就活状況が保存される');
    check(
      !('targetJobs' in next) && !('preferredLocations' in next),
      '空項目はキーごと持たせない（AI input hash / sync revision を無用に変えない）',
    );

    // 空へ戻すとキーが消える（残骸が prompt に残らない）。
    const cleared = applyCareerAspiration(next, EMPTY_CAREER_ASPIRATION);
    check(
      !('targetIndustries' in cleared) && !('jobHuntingStatus' in cleared),
      '空へ戻すとキーが削除される',
    );

    // 読み出し round trip。
    const roundTrip = readCareerAspiration(next);
    check(
      roundTrip.targetIndustries.join(',') === 'メーカー,商社' &&
        roundTrip.jobHuntingStatus === '面接が進行中',
      'readCareerAspiration が canonical profile から復元できる',
    );

    // 保存経路が canonical 3 段（LS → mirror → Layer 2）である。
    const save = read('app/career/mypage/saveCareerAspiration.ts');
    const iLs = save.indexOf('saveBasicInfo(profile)');
    const iMirror = save.indexOf('saveCareerProfileToSupabase(userId, profile)');
    const iMemory = save.indexOf('void shadowWriteBaseMemory()');
    check(iLs >= 0 && iMirror > iLs && iMemory > iMirror, 'canonical → mirror → Layer 2 の順で書く');
    check(
      /if \(userId && profile\)/.test(save),
      'mirror 書き込みは member のみ（guest は localStorage canonical のみ）',
    );

    // /career/profile の保存が志望条件を消さない（非破壊更新）。
    const profileClient = read('app/career/profile/ProfileClient.tsx');
    check(
      /function toProfile\(form: ProfileForm, base: CareerProfile \| null\)/.test(profileClient) &&
        /\.\.\.\(base \?\? \{\}\)/.test(profileClient),
      'ProfileClient はプロフィール保存時に既存 canonical field を温存する',
    );
  }

  // ── M5: prompt reachability（Layer 1 / Layer 2 の両経路） ──────────
  console.log('\n[M5] prompt reachability');
  {
    const MARKER = 'ゼータ総研';
    const edited = applyCareerAspiration(PROFILE, {
      ...readCareerAspiration(PROFILE),
      targetCompanies: [MARKER],
      targetIndustries: ['コンサル'],
    });
    const bundle: CareerSourceBundle = { ...FULL_BUNDLE, profile: edited };

    // (a) Layer 1 → base system prompt（全 purpose 共通の buildCareerSystemPrompt 経路）。
    const ctx = buildCareerAiContext({
      featureKey: 'career-consultation',
      profile: edited,
      activity: ACTIVITY,
      values: VALUES,
      userInput: '',
    });
    const PURPOSES: CareerContextPurpose[] = [
      'consultation',
      'es_review',
      'es_deep_dive',
      'interview_practice',
      'gd_feedback',
      'presentation_feedback',
      'company_research_review',
      'matching',
      'self_analysis',
      'self_analysis_deep_dive',
    ];
    for (const purpose of PURPOSES) {
      const out = buildCareerContextForPurpose(purpose, ctx);
      check(
        out.systemPrompt.includes(MARKER),
        `${purpose}: マイページ編集値が base prompt へ到達`,
      );
    }

    // (b) Layer 2 → personal memory block（Memory を受け取る purpose のみ）。
    const baseSection = projectSectionFromSource('base', bundle);
    check(baseSection !== null, 'Layer 2 base section が projection できる');
    if (baseSection) {
      check(
        JSON.stringify(baseSection.section.payload).includes(MARKER),
        'Layer 2 base payload に編集値が載る',
      );
      for (const purpose of ['interview_practice', 'consultation', 'company_research_review'] as const) {
        const block = renderPersonalMemoryForPurpose(purpose, [baseSection.section]).block;
        check(block.includes(MARKER), `${purpose}: Layer 2 block へ到達`);
      }
    }

    // (c) 編集が Layer 2 revision を変える（＝古い Memory が fresh 判定に残らない）。
    const before = projectSectionFromSource('base', FULL_BUNDLE)?.sourceRevision;
    const after = baseSection?.sourceRevision;
    check(
      !!before && !!after && before !== after,
      '編集で base の sourceRevision が変わる（stale 検出が効く）',
    );
  }

  // ── M6: マイページ専用の第 2 データ体系を作っていない ──────────────
  console.log('\n[M6] no second store');
  {
    const files = readdirSync(MYPAGE_DIR).filter((f) => /\.tsx?$/.test(f));
    check(files.length > 0, 'mypage ディレクトリを走査できる');
    for (const f of files) {
      const src = readFileSync(join(MYPAGE_DIR, f), 'utf8');
      // 独自 localStorage キー / 独自 storage helper を持たない。
      check(
        !/safeSetStorage|localStorage\.setItem|window\.localStorage/.test(src),
        `${f}: 独自の localStorage 書き込みを持たない`,
      );
      // 独自 Supabase table を持たない（保存は既存 canonical helper 経由のみ）。
      check(
        !/from\(['"]mypage|career_mypage|\.from\(['"]career_(?!user_events)/.test(src),
        `${f}: 独自 table へ直接アクセスしない`,
      );
    }
    // 保存は canonical helper だけを import している。
    const save = read('app/career/mypage/saveCareerAspiration.ts');
    check(
      save.includes("from '@/app/career/profile/profileStorage'") &&
        save.includes("from '@/lib/supabase/careerProfile'") &&
        save.includes("from '@/app/career/personalMemoryShadowWrite'"),
      '保存は既存 canonical helper のみを使う（新 writer を作らない）',
    );
  }

  // ── M7: 境界（AI call 非新設 / Company Spine 非混入 / 型 orphan なし） ─
  console.log('\n[M7] boundaries');
  {
    const files = readdirSync(MYPAGE_DIR).filter((f) => /\.tsx?$/.test(f));
    for (const f of files) {
      const src = readFileSync(join(MYPAGE_DIR, f), 'utf8');
      check(
        !/buildCareerContextForPurpose|fetch\(['"`]\/api\/career\/(consultation|es|interview|presentation|gd|matching|self-analysis|company-research)/.test(src),
        `${f}: マイページから AI call を新設していない`,
      );
      check(
        !/careerCompanyKnowledge|careerCompanySpine|companyOfficial|careerCompanyPrefetch/.test(src),
        `${f}: Company Data Spine を User Data Spine へ混ぜない`,
      );
      check(
        !/careerAggregate|careerCollectiveIntelligence/.test(src),
        `${f}: Layer 4 集約を production 表示へ引き込まない`,
      );
    }
    // mypage_summary purpose は DORMANT のまま（live callsite を作っていない）。
    for (const f of files) {
      const src = readFileSync(join(MYPAGE_DIR, f), 'utf8');
      // 判定は closure QA と同じ「実行される呼び出し」基準（コメント中の言及は数えない）。
      check(
        !/buildCareerContextForPurpose\(\s*['"]mypage_summary['"]/.test(src),
        `${f}: mypage_summary purpose を通電していない（DORMANT 維持）`,
      );
    }
    // Layer 3（Event Log）を Layer 2 view へ混ぜない（D-L3 禁止辺）。
    const view = read('app/career/mypage/mypageDataSpineView.ts');
    check(
      !/careerEvents|eventSignal|EventSignal|loadCareerUserEvents/.test(view),
      'view module は Layer 3 / Event Signal を読まない（D-L3）',
    );
    // 進捗・履歴集約も同じ bundle から導く（マイページ内で loader を叩き直さない）。
    const summary = read('app/career/mypage/mypageSummary.ts');
    check(
      /buildMypageSummary\(bundle: CareerSourceBundle\)/.test(summary),
      'buildMypageSummary は Layer 1 bundle を受け取る',
    );
    check(
      !/loadBasicInfo|loadActivityData|loadCareerValues|loadSelfAnalysisLogs|loadEsLogs|loadInterviewResults|loadMatchingLogs|loadCompanyResearchLogs|loadPresentationResults|loadConsultationThreads/.test(summary),
      'bundle が供給する Source を個別 loader で二重読みしない',
    );
  }

  console.log('');
  console.log(
    failures === 0
      ? 'career-mypage-data-spine-qa: ALL PASS'
      : `career-mypage-data-spine-qa: ${failures} FAIL`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
