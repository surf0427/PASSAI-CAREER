'use client';

// 就活版（PASSAI CAREER）「活動整理」(/career/activity)
//
// 受験版の活動整理を就活版向けに置き換えたページ。ユーザーのこれまでの経験・人物像・
// スキルを 18 セクションで整理し、自己分析・ES・面接・企業マッチング・相談などの
// 就活 AI が参照する「基盤データベース」を作る。
//
// 方針:
//   - すべての入力は任意。必須・バリデーションは設けない。
//   - canonical は localStorage（activityStorage）。入力のたびに自動保存する。
//   - 基本情報（/career/profile）・就活軸整理（/career/values）と重複する項目は持たない。
//   - 経験系（アルバイト・インターン・サークル・プロジェクト・リーダー・ボランティア）は
//     複数登録でき、各経験に「期間・役割・人数規模・工夫・定量的な成果・学び」を持つ
//     （ES・面接で AI が最適なエピソードを根拠とともに選べるようにするため）。
//   - hydration は他の career ページと同形（SSR は mount フラグ false で null）。

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import Link from 'next/link';
import { PageHeader } from '@/components/ui/PageHeader';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { SectionCard } from '@/components/career/activity/SectionCard';
import {
  TextField,
  TextareaField,
  SelectField,
} from '@/components/career/activity/ActivityField';
import { RepeatableList } from '@/components/career/activity/RepeatableList';
import { ExperienceTail } from '@/components/career/activity/ExperienceTail';
import {
  loadActivityData,
  saveActivityData,
  normalizeCareerActivity,
} from './activityStorage';
import {
  IT_SKILL_LEVELS,
  IT_SKILL_SUGGESTIONS,
  LANGUAGE_LEVELS,
  LANGUAGE_SUGGESTIONS,
  MBTI_TYPES,
  PROJECT_EXAMPLES,
  SNS_EXAMPLES,
  SNS_PLATFORM_SUGGESTIONS,
  PORTFOLIO_EXAMPLES,
  PORTFOLIO_KIND_SUGGESTIONS,
  FOCUSED_ACTIVITY_CATEGORY_SUGGESTIONS,
  FOCUSED_ACTIVITY_EXAMPLES,
  OVERSEAS_KINDS,
} from './careerActivityCategories';
import type { CareerActivity } from '@/types/careerActivity';
import {
  emptyCareerActivity,
  newFocusedActivityEntry,
  newOverseasEntry,
  newPartTimeJobEntry,
  newInternshipEntry,
  newClubEntry,
  newProjectEntry,
  newLeadershipEntry,
  newVolunteerEntry,
  newCertificationEntry,
  newItSkillEntry,
  newLanguageEntry,
  newSnsEntry,
  newPortfolioEntry,
} from '@/types/careerActivity';
import { useCurrentUserId } from '@/app/components/AuthProvider';
import {
  loadCareerActivityFromSupabase,
  saveCareerActivityToSupabase,
} from '@/lib/supabase/careerActivity';

// SSR-stable mount flag（home/values と同形）。
const subscribeMount = () => () => {};
const getMountedSnapshot = () => true;
const getMountedServerSnapshot = () => false;

export default function CareerActivityPage() {
  const isMounted = useSyncExternalStore(
    subscribeMount,
    getMountedSnapshot,
    getMountedServerSnapshot,
  );

  const initial = useMemo<CareerActivity | null>(
    () => (isMounted ? loadActivityData() : null),
    [isMounted],
  );

  if (!isMounted) return null;

  return <ActivityForm key={initial ? 'stored' : 'empty'} initial={initial} />;
}

// 単発オブジェクトセクション（複数登録なし）のキー。
type ObjSectionKey =
  | 'personality'
  | 'academics'
  | 'lifeExperiences';

// 自由記述（トップレベル string）フィールドのキー。
type TextFieldKey = 'hobbies' | 'awards' | 'freeNote';

function ActivityForm({ initial }: { initial: CareerActivity | null }) {
  const [activity, setActivity] = useState<CareerActivity>(
    () => initial ?? emptyCareerActivity(),
  );
  const [dirty, setDirty] = useState(false);

  const userId = useCurrentUserId();
  const userIdRef = useRef(userId);
  useEffect(() => {
    userIdRef.current = userId;
  }, [userId]);
  // 初期表示時点で localStorage が空だったか（down-sync を 1 回だけ許可する条件）。
  const localWasEmpty = initial === null;
  // ユーザーが編集を始めたら true。Supabase からの遅延 down-sync で上書きしない。
  const editedRef = useRef(false);
  // Supabase mirror の debounce（自動保存のたびに送らず、入力が落ち着いてから 1 回送る）。
  const mirrorPendingRef = useRef<CareerActivity | null>(null);
  const mirrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 入力のたびに自動保存（初回マウントはスキップ）。effect 内では setState しない
  // （react-hooks/set-state-in-effect 回避。dirty フラグは編集ハンドラ側で立てる）。
  const didMount = useRef(false);
  useEffect(() => {
    if (!didMount.current) {
      didMount.current = true;
      return;
    }
    const toSave = { ...activity, updatedAt: new Date().toISOString() };
    saveActivityData(toSave); // localStorage canonical
    // Supabase durable mirror（best-effort / member のみ / debounce）。
    if (userIdRef.current) {
      mirrorPendingRef.current = toSave;
      if (mirrorTimerRef.current) clearTimeout(mirrorTimerRef.current);
      mirrorTimerRef.current = setTimeout(() => {
        const pending = mirrorPendingRef.current;
        mirrorPendingRef.current = null;
        mirrorTimerRef.current = null;
        if (pending && userIdRef.current) {
          void saveCareerActivityToSupabase(userIdRef.current, pending);
        }
      }, 1500);
    }
  }, [activity]);

  // アンマウント時に未送信の mirror を flush する（高速に離脱しても取りこぼさない）。
  useEffect(() => {
    return () => {
      if (mirrorTimerRef.current) clearTimeout(mirrorTimerRef.current);
      const pending = mirrorPendingRef.current;
      if (pending && userIdRef.current) {
        void saveCareerActivityToSupabase(userIdRef.current, pending);
      }
    };
  }, []);

  // localStorage が空 + ログイン済みなら、Supabase の durable mirror から 1 回だけ復元する。
  useEffect(() => {
    if (!userId || !localWasEmpty) return;
    let cancelled = false;
    (async () => {
      const result = await loadCareerActivityFromSupabase(userId);
      if (cancelled || editedRef.current) return;
      if (result.kind === 'ok') {
        // Supabase の durable mirror は旧スキーマ（overseas=単発オブジェクト／
        // academics.focusedEffort=ガクチカ）で書かれている場合があるため、必ず正規化してから
        // state / LS に入れる（新カード構造の array 前提の描画で落ちないようにする）。
        const normalized = normalizeCareerActivity(result.activity);
        saveActivityData(normalized); // LS canonical に揃える
        setActivity(normalized);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, localWasEmpty]);

  const update = useCallback((updater: (prev: CareerActivity) => CareerActivity) => {
    editedRef.current = true;
    setDirty(true);
    setActivity(updater);
  }, []);

  // 単発オブジェクトセクションのフィールド更新。
  const setObj = useCallback(
    <S extends ObjSectionKey>(
      section: S,
      key: keyof CareerActivity[S],
      value: string,
    ) => {
      update((prev) => ({
        ...prev,
        [section]: { ...prev[section], [key]: value },
      }) as CareerActivity);
    },
    [update],
  );

  // 自由記述フィールド更新。
  const setText = useCallback(
    (key: TextFieldKey, value: string) => {
      update((prev) => ({ ...prev, [key]: value }));
    },
    [update],
  );

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-10 pb-28">
      <Link
        href="/career/home"
        className="inline-block mb-4 text-sm text-gray-500 hover:text-gray-800 transition-colors"
      >
        ← キャリアホームに戻る
      </Link>

      <PageHeader
        title="活動整理"
        description="これまでの経験・人物像・スキルを整理して、AI があなたを深く理解するための土台をつくります。"
      />

      {/* 💡 説明文 */}
      <Card variant="soft" padding="md" className="mb-6">
        <p className="text-sm font-bold text-gray-800 mb-2">💡 活動整理について</p>
        <ul className="space-y-1.5 text-sm text-gray-600 leading-relaxed">
          <li>活動整理の入力は<strong>すべて任意</strong>です。</li>
          <li>
            入力いただいた情報は、自己分析・ES作成・面接対策・企業マッチングなどの AI
            機能で活用されます。
          </li>
          <li>
            入力項目が多いほど、あなたに合わせた、より精度の高い分析・アドバイス・提案ができるようになります。
          </li>
          <li className="text-gray-400">入力内容は自動保存されます。</li>
        </ul>
      </Card>

      <div className="space-y-5">
        {/* ① MBTI・性格 */}
        <SectionCard
          emoji="🧭"
          title="MBTI・性格"
          description="あなたの人物像を AI が理解するための基本情報です。"
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <TextField
              label="MBTI"
              value={activity.personality.mbti}
              onChange={(v) => setObj('personality', 'mbti', v)}
              placeholder="例：ENFP（未診断でも空欄でOK）"
              suggestions={MBTI_TYPES}
            />
            <TextField
              label="自分で思う性格"
              value={activity.personality.selfView}
              onChange={(v) => setObj('personality', 'selfView', v)}
              placeholder="例：好奇心が強く、こつこつ続けられる"
            />
            <TextField
              label="周囲から言われる性格"
              value={activity.personality.othersView}
              onChange={(v) => setObj('personality', 'othersView', v)}
              placeholder="例：聞き上手、面倒見が良い"
            />
            <TextField
              label="強み"
              value={activity.personality.strengths}
              onChange={(v) => setObj('personality', 'strengths', v)}
              placeholder="例：課題を分解して計画的に進められる"
            />
            <TextField
              label="弱み"
              value={activity.personality.weaknesses}
              onChange={(v) => setObj('personality', 'weaknesses', v)}
              placeholder="例：慎重になりすぎることがある"
            />
            <TextField
              label="大切にしている価値観"
              value={activity.personality.values}
              onChange={(v) => setObj('personality', 'values', v)}
              placeholder="例：誠実さ／挑戦／チームでの達成"
            />
            <TextField
              label="モチベーションが上がる環境"
              value={activity.personality.motivationUp}
              onChange={(v) => setObj('personality', 'motivationUp', v)}
              placeholder="例：裁量があり、成長を実感できる環境"
            />
            <TextField
              label="モチベーションが下がる環境"
              value={activity.personality.motivationDown}
              onChange={(v) => setObj('personality', 'motivationDown', v)}
              placeholder="例：理由の説明がない指示が多い環境"
            />
          </div>
        </SectionCard>

        {/* ② 学業・学生時代の活動（授業・ゼミ・研究・専攻・学業面の取り組み） */}
        <SectionCard
          emoji="📚"
          title="学業・学生時代の活動"
          description="授業・ゼミ・研究・専攻など、学業面の取り組みを整理します。打ち込んだ活動（ガクチカ）は下の「学生時代に力を入れたこと」に登録できます。"
        >
          <div className="space-y-3">
            <TextareaField
              label="ゼミ・研究"
              value={activity.academics.seminar}
              onChange={(v) => setObj('academics', 'seminar', v)}
              placeholder="ゼミ・研究室のテーマや取り組み内容"
            />
            <TextareaField
              label="卒業研究・卒論（任意）"
              value={activity.academics.thesis}
              onChange={(v) => setObj('academics', 'thesis', v)}
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <TextField
                label="印象に残った授業"
                value={activity.academics.memorableClass}
                onChange={(v) => setObj('academics', 'memorableClass', v)}
              />
              <TextField
                label="GPA（任意）"
                value={activity.academics.gpa}
                onChange={(v) => setObj('academics', 'gpa', v)}
                placeholder="例：3.4 / 4.0"
              />
            </div>
            <TextField
              label="成績・受賞歴（任意）"
              value={activity.academics.academicAwards}
              onChange={(v) => setObj('academics', 'academicAwards', v)}
              placeholder="例：成績優秀者表彰、学会発表 など"
            />
          </div>
        </SectionCard>

        {/* ②' 学生時代に力を入れたこと（ガクチカ・複数カード） */}
        <SectionCard
          emoji="🔥"
          title="学生時代に力を入れたこと"
          description={`いわゆる「ガクチカ」。ES・面接・自己PR で最も使う項目です。エピソードごとにカードで複数登録できます。例：${FOCUSED_ACTIVITY_EXAMPLES}`}
        >
          <RepeatableList
            items={activity.focusedActivities}
            addLabel="学生時代に力を入れたことを追加"
            emptyHint="打ち込んだ経験を 1 つずつカードで追加してください（アルバイト・サークル・学業・インターン など）。"
            itemLabel={(i) => `力を入れたこと ${i + 1}`}
            onAdd={() =>
              update((p) => ({
                ...p,
                focusedActivities: [
                  ...p.focusedActivities,
                  newFocusedActivityEntry(),
                ],
              }))
            }
            onRemove={(id) =>
              update((p) => ({
                ...p,
                focusedActivities: p.focusedActivities.filter(
                  (it) => it.id !== id,
                ),
              }))
            }
            renderItem={(item) => {
              const patch = (patchObj: Partial<typeof item>) =>
                update((p) => ({
                  ...p,
                  focusedActivities: p.focusedActivities.map((it) =>
                    it.id === item.id ? { ...it, ...patchObj } : it,
                  ),
                }));
              return (
                <>
                  <TextField
                    label="タイトル"
                    value={item.title}
                    onChange={(v) => patch({ title: v })}
                    placeholder="例：カフェのアルバイトでの売上改善"
                  />
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <TextField
                      label="活動カテゴリ"
                      value={item.category}
                      onChange={(v) => patch({ category: v })}
                      placeholder="例：アルバイト / サークル / 学業"
                      suggestions={FOCUSED_ACTIVITY_CATEGORY_SUGGESTIONS}
                    />
                    <TextField
                      label="所属・組織・場面"
                      value={item.organization}
                      onChange={(v) => patch({ organization: v })}
                      placeholder="例：個人経営のカフェ／◯◯サークル"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <TextField
                      label="期間（開始）"
                      value={item.period.from}
                      onChange={(v) =>
                        patch({ period: { ...item.period, from: v } })
                      }
                      placeholder="2023年4月"
                    />
                    <TextField
                      label="期間（終了）"
                      value={item.period.to}
                      onChange={(v) =>
                        patch({ period: { ...item.period, to: v } })
                      }
                      placeholder="現在 / 2024年3月"
                    />
                  </div>
                  <TextField
                    label="役割"
                    value={item.role}
                    onChange={(v) => patch({ role: v })}
                    placeholder="例：リーダー / 会計 / フロント担当"
                  />
                  <TextareaField
                    label="目標・課題"
                    value={item.goal}
                    onChange={(v) => patch({ goal: v })}
                    placeholder="何を目指した／どんな課題があったかを書いてください。"
                  />
                  <TextareaField
                    label="具体的な行動"
                    value={item.action}
                    onChange={(v) => patch({ action: v })}
                    placeholder="課題に対して実際に取り組んだことを書いてください。"
                  />
                  <TextareaField
                    label="工夫したこと"
                    value={item.ingenuity}
                    onChange={(v) => patch({ ingenuity: v })}
                    placeholder="自分なりに工夫・意識した点を書いてください。"
                  />
                  <TextareaField
                    label="困難だったこと"
                    value={item.difficulty}
                    onChange={(v) => patch({ difficulty: v })}
                    placeholder="つまずいた点・大変だったことを書いてください。"
                  />
                  <TextareaField
                    label="成果・実績"
                    value={item.result}
                    onChange={(v) => patch({ result: v })}
                    placeholder="取り組みの結果どうなったかを書いてください。"
                  />
                  <TextareaField
                    label="数字で表せる成果"
                    value={item.quantitativeResult}
                    onChange={(v) => patch({ quantitativeResult: v })}
                    hint="数字を入れると ES・面接で説得力が増します"
                    placeholder="例：売上15%改善 / 参加者200人 / 業務時間30分短縮"
                  />
                  <TextareaField
                    label="学び"
                    value={item.learning}
                    onChange={(v) => patch({ learning: v })}
                    placeholder="この経験から得た学び・強みにつながった点を書いてください。"
                  />
                  <TextareaField
                    label="ES/面接で使いたい度・メモ"
                    value={item.memo}
                    onChange={(v) => patch({ memo: v })}
                    placeholder="例：本命企業の面接で使いたい／リーダーシップの根拠に使える など"
                  />
                </>
              );
            }}
          />
        </SectionCard>

        {/* ③ アルバイト */}
        <SectionCard emoji="🧑‍🍳" title="アルバイト" description="複数登録できます。">
          <RepeatableList
            items={activity.partTimeJobs}
            addLabel="アルバイトを追加"
            emptyHint="経験したアルバイトを追加してください。"
            itemLabel={(i) => `アルバイト ${i + 1}`}
            onAdd={() =>
              update((p) => ({
                ...p,
                partTimeJobs: [...p.partTimeJobs, newPartTimeJobEntry()],
              }))
            }
            onRemove={(id) =>
              update((p) => ({
                ...p,
                partTimeJobs: p.partTimeJobs.filter((it) => it.id !== id),
              }))
            }
            renderItem={(item) => {
              const patch = (patchObj: Partial<typeof item>) =>
                update((p) => ({
                  ...p,
                  partTimeJobs: p.partTimeJobs.map((it) =>
                    it.id === item.id ? { ...it, ...patchObj } : it,
                  ),
                }));
              return (
                <>
                  <TextField
                    label="勤務先"
                    value={item.workplace}
                    onChange={(v) => patch({ workplace: v })}
                    placeholder="例：カフェ／個別指導塾"
                  />
                  <TextareaField
                    label="業務内容"
                    value={item.jobContent}
                    onChange={(v) => patch({ jobContent: v })}
                  />
                  <ExperienceTail item={item} patch={patch} />
                </>
              );
            }}
          />
        </SectionCard>

        {/* ④ インターン */}
        <SectionCard emoji="🏢" title="インターン" description="複数登録できます。">
          <RepeatableList
            items={activity.internships}
            addLabel="インターンを追加"
            emptyHint="参加したインターンを追加してください。"
            itemLabel={(i) => `インターン ${i + 1}`}
            onAdd={() =>
              update((p) => ({
                ...p,
                internships: [...p.internships, newInternshipEntry()],
              }))
            }
            onRemove={(id) =>
              update((p) => ({
                ...p,
                internships: p.internships.filter((it) => it.id !== id),
              }))
            }
            renderItem={(item) => {
              const patch = (patchObj: Partial<typeof item>) =>
                update((p) => ({
                  ...p,
                  internships: p.internships.map((it) =>
                    it.id === item.id ? { ...it, ...patchObj } : it,
                  ),
                }));
              return (
                <>
                  <TextField
                    label="企業名"
                    value={item.companyName}
                    onChange={(v) => patch({ companyName: v })}
                  />
                  <TextareaField
                    label="業務内容"
                    value={item.jobContent}
                    onChange={(v) => patch({ jobContent: v })}
                  />
                  <ExperienceTail item={item} patch={patch} />
                </>
              );
            }}
          />
        </SectionCard>

        {/* ⑤ サークル・部活動 */}
        <SectionCard
          emoji="🎽"
          title="サークル・部活動"
          description="複数登録できます。"
        >
          <RepeatableList
            items={activity.club}
            addLabel="サークル・部活動を追加"
            emptyHint="所属していた団体を追加してください。"
            itemLabel={(i) => `サークル・部活動 ${i + 1}`}
            onAdd={() =>
              update((p) => ({ ...p, club: [...p.club, newClubEntry()] }))
            }
            onRemove={(id) =>
              update((p) => ({
                ...p,
                club: p.club.filter((it) => it.id !== id),
              }))
            }
            renderItem={(item) => {
              const patch = (patchObj: Partial<typeof item>) =>
                update((p) => ({
                  ...p,
                  club: p.club.map((it) =>
                    it.id === item.id ? { ...it, ...patchObj } : it,
                  ),
                }));
              return (
                <>
                  <TextField
                    label="団体名"
                    value={item.organizationName}
                    onChange={(v) => patch({ organizationName: v })}
                  />
                  <TextareaField
                    label="活動内容"
                    value={item.activityContent}
                    onChange={(v) => patch({ activityContent: v })}
                  />
                  <ExperienceTail item={item} patch={patch} />
                </>
              );
            }}
          />
        </SectionCard>

        {/* ⑥ プロジェクト経験 */}
        <SectionCard
          emoji="🚀"
          title="プロジェクト経験"
          description={`複数登録できます。例：${PROJECT_EXAMPLES}`}
        >
          <RepeatableList
            items={activity.projects}
            addLabel="プロジェクトを追加"
            emptyHint="取り組んだプロジェクトを追加してください。"
            itemLabel={(i) => `プロジェクト ${i + 1}`}
            onAdd={() =>
              update((p) => ({
                ...p,
                projects: [...p.projects, newProjectEntry()],
              }))
            }
            onRemove={(id) =>
              update((p) => ({
                ...p,
                projects: p.projects.filter((it) => it.id !== id),
              }))
            }
            renderItem={(item) => {
              const patch = (patchObj: Partial<typeof item>) =>
                update((p) => ({
                  ...p,
                  projects: p.projects.map((it) =>
                    it.id === item.id ? { ...it, ...patchObj } : it,
                  ),
                }));
              return (
                <>
                  <TextField
                    label="プロジェクト名"
                    value={item.name}
                    onChange={(v) => patch({ name: v })}
                  />
                  <TextareaField
                    label="内容"
                    value={item.content}
                    onChange={(v) => patch({ content: v })}
                  />
                  <ExperienceTail item={item} patch={patch} />
                </>
              );
            }}
          />
        </SectionCard>

        {/* ⑦ リーダー経験 */}
        <SectionCard emoji="🧗" title="リーダー経験" description="複数登録できます。">
          <RepeatableList
            items={activity.leadership}
            addLabel="リーダー経験を追加"
            emptyHint="リーダーとして取り組んだ経験を追加してください。"
            itemLabel={(i) => `リーダー経験 ${i + 1}`}
            onAdd={() =>
              update((p) => ({
                ...p,
                leadership: [...p.leadership, newLeadershipEntry()],
              }))
            }
            onRemove={(id) =>
              update((p) => ({
                ...p,
                leadership: p.leadership.filter((it) => it.id !== id),
              }))
            }
            renderItem={(item) => {
              const patch = (patchObj: Partial<typeof item>) =>
                update((p) => ({
                  ...p,
                  leadership: p.leadership.map((it) =>
                    it.id === item.id ? { ...it, ...patchObj } : it,
                  ),
                }));
              return (
                <>
                  <TextareaField
                    label="経験内容"
                    value={item.experience}
                    onChange={(v) => patch({ experience: v })}
                    placeholder="どんな場面で、何のリーダーを務めたかを書いてください。"
                  />
                  <ExperienceTail item={item} patch={patch} />
                </>
              );
            }}
          />
        </SectionCard>

        {/* ⑧ ボランティア・社会活動 */}
        <SectionCard
          emoji="🤝"
          title="ボランティア・社会活動"
          description="複数登録できます。"
        >
          <RepeatableList
            items={activity.volunteer}
            addLabel="ボランティア・社会活動を追加"
            emptyHint="参加した活動を追加してください。"
            itemLabel={(i) => `ボランティア・社会活動 ${i + 1}`}
            onAdd={() =>
              update((p) => ({
                ...p,
                volunteer: [...p.volunteer, newVolunteerEntry()],
              }))
            }
            onRemove={(id) =>
              update((p) => ({
                ...p,
                volunteer: p.volunteer.filter((it) => it.id !== id),
              }))
            }
            renderItem={(item) => {
              const patch = (patchObj: Partial<typeof item>) =>
                update((p) => ({
                  ...p,
                  volunteer: p.volunteer.map((it) =>
                    it.id === item.id ? { ...it, ...patchObj } : it,
                  ),
                }));
              return (
                <>
                  <TextareaField
                    label="活動内容"
                    value={item.activityContent}
                    onChange={(v) => patch({ activityContent: v })}
                  />
                  <ExperienceTail item={item} patch={patch} />
                </>
              );
            }}
          />
        </SectionCard>

        {/* ⑨ 海外経験（複数カード） */}
        <SectionCard
          emoji="✈️"
          title="海外経験"
          description="留学・ワーキングホリデー・語学学校・海外旅行・インターン・国際交流 など。複数登録できます。"
        >
          <RepeatableList
            items={activity.overseas}
            addLabel="海外経験を追加"
            emptyHint="経験した海外渡航を 1 つずつカードで追加してください。"
            itemLabel={(i) => `海外経験 ${i + 1}`}
            onAdd={() =>
              update((p) => ({
                ...p,
                overseas: [...p.overseas, newOverseasEntry()],
              }))
            }
            onRemove={(id) =>
              update((p) => ({
                ...p,
                overseas: p.overseas.filter((it) => it.id !== id),
              }))
            }
            renderItem={(item) => {
              const patch = (patchObj: Partial<typeof item>) =>
                update((p) => ({
                  ...p,
                  overseas: p.overseas.map((it) =>
                    it.id === item.id ? { ...it, ...patchObj } : it,
                  ),
                }));
              return (
                <>
                  <TextField
                    label="タイトル"
                    value={item.title}
                    onChange={(v) => patch({ title: v })}
                    placeholder="例：カナダ・バンクーバーへの語学留学"
                  />
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <TextField
                      label="国・地域"
                      value={item.country}
                      onChange={(v) => patch({ country: v })}
                      placeholder="例：カナダ"
                    />
                    <TextField
                      label="都市"
                      value={item.city}
                      onChange={(v) => patch({ city: v })}
                      placeholder="例：バンクーバー"
                    />
                    <SelectField
                      label="種別"
                      value={item.kind}
                      onChange={(v) => patch({ kind: v })}
                      options={OVERSEAS_KINDS}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <TextField
                      label="期間（開始）"
                      value={item.period.from}
                      onChange={(v) =>
                        patch({ period: { ...item.period, from: v } })
                      }
                      placeholder="2023年8月"
                    />
                    <TextField
                      label="期間（終了）"
                      value={item.period.to}
                      onChange={(v) =>
                        patch({ period: { ...item.period, to: v } })
                      }
                      placeholder="2023年11月"
                    />
                  </div>
                  <TextField
                    label="所属・学校・プログラム名"
                    value={item.program}
                    onChange={(v) => patch({ program: v })}
                    placeholder="例：◯◯語学学校 / 交換留学プログラム"
                  />
                  <TextareaField
                    label="目的"
                    value={item.purpose}
                    onChange={(v) => patch({ purpose: v })}
                    placeholder="なぜ行ったのか、何を目指したかを書いてください。"
                  />
                  <TextareaField
                    label="現地で取り組んだこと"
                    value={item.activityContent}
                    onChange={(v) => patch({ activityContent: v })}
                    placeholder="現地での学び・活動・チャレンジしたことを書いてください。"
                  />
                  <TextareaField
                    label="困難だったこと"
                    value={item.difficulty}
                    onChange={(v) => patch({ difficulty: v })}
                    placeholder="言語・文化・生活面などで大変だったこと。"
                  />
                  <TextareaField
                    label="乗り越え方"
                    value={item.howOvercome}
                    onChange={(v) => patch({ howOvercome: v })}
                    placeholder="困難にどう向き合い、乗り越えたかを書いてください。"
                  />
                  <TextareaField
                    label="得た価値観・学び"
                    value={item.learning}
                    onChange={(v) => patch({ learning: v })}
                  />
                  <TextField
                    label="語学面の変化"
                    value={item.languageGrowth}
                    onChange={(v) => patch({ languageGrowth: v })}
                    placeholder="例：TOEIC 650→820 / 日常会話に困らなくなった"
                  />
                  <TextareaField
                    label="就活で使えそうな強み"
                    value={item.strength}
                    onChange={(v) => patch({ strength: v })}
                    placeholder="例：主体性 / 適応力 / 多様な価値観への理解"
                  />
                  <TextareaField
                    label="メモ"
                    value={item.memo}
                    onChange={(v) => patch({ memo: v })}
                    placeholder="ES・面接で使いたい点や補足を自由に。"
                  />
                </>
              );
            }}
          />
        </SectionCard>

        {/* ⑩ 資格 */}
        <SectionCard
          emoji="📜"
          title="資格"
          description="複数登録できます。例：TOEIC・IELTS・簿記・IT資格 など"
        >
          <RepeatableList
            items={activity.certifications}
            addLabel="資格を追加"
            emptyHint="保有資格を追加してください。"
            itemLabel={(i) => `資格 ${i + 1}`}
            onAdd={() =>
              update((p) => ({
                ...p,
                certifications: [...p.certifications, newCertificationEntry()],
              }))
            }
            onRemove={(id) =>
              update((p) => ({
                ...p,
                certifications: p.certifications.filter((it) => it.id !== id),
              }))
            }
            renderItem={(item) => {
              const patch = (patchObj: Partial<typeof item>) =>
                update((p) => ({
                  ...p,
                  certifications: p.certifications.map((it) =>
                    it.id === item.id ? { ...it, ...patchObj } : it,
                  ),
                }));
              return (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <TextField
                    label="資格名"
                    value={item.name}
                    onChange={(v) => patch({ name: v })}
                    placeholder="例：TOEIC"
                  />
                  <TextField
                    label="スコア・級"
                    value={item.score}
                    onChange={(v) => patch({ score: v })}
                    placeholder="例：850点 / 2級"
                  />
                  <TextField
                    label="取得時期"
                    value={item.acquiredDate}
                    onChange={(v) => patch({ acquiredDate: v })}
                    placeholder="例：2024年6月"
                  />
                </div>
              );
            }}
          />
        </SectionCard>

        {/* ⑪ ITスキル */}
        <SectionCard
          emoji="💻"
          title="ITスキル"
          description="複数登録できます。スキル名は自由入力できます。"
        >
          <RepeatableList
            items={activity.itSkills}
            addLabel="ITスキルを追加"
            emptyHint="使えるツール・言語を追加してください。"
            itemLabel={(i) => `スキル ${i + 1}`}
            onAdd={() =>
              update((p) => ({
                ...p,
                itSkills: [...p.itSkills, newItSkillEntry()],
              }))
            }
            onRemove={(id) =>
              update((p) => ({
                ...p,
                itSkills: p.itSkills.filter((it) => it.id !== id),
              }))
            }
            renderItem={(item) => {
              const patch = (patchObj: Partial<typeof item>) =>
                update((p) => ({
                  ...p,
                  itSkills: p.itSkills.map((it) =>
                    it.id === item.id ? { ...it, ...patchObj } : it,
                  ),
                }));
              return (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <TextField
                    label="スキル名"
                    value={item.name}
                    onChange={(v) => patch({ name: v })}
                    placeholder="例：Python / Excel / Figma"
                    suggestions={IT_SKILL_SUGGESTIONS}
                  />
                  <SelectField
                    label="スキルレベル"
                    value={item.level}
                    onChange={(v) => patch({ level: v as typeof item.level })}
                    options={IT_SKILL_LEVELS}
                  />
                </div>
              );
            }}
          />
        </SectionCard>

        {/* ⑫ 語学 */}
        <SectionCard
          emoji="🗣️"
          title="語学"
          description="複数登録できます。レベルは CEFR（C2〜A1）またはネイティブで選べます。"
        >
          <RepeatableList
            items={activity.languages}
            addLabel="語学を追加"
            emptyHint="話せる言語を追加してください。"
            itemLabel={(i) => `語学 ${i + 1}`}
            onAdd={() =>
              update((p) => ({
                ...p,
                languages: [...p.languages, newLanguageEntry()],
              }))
            }
            onRemove={(id) =>
              update((p) => ({
                ...p,
                languages: p.languages.filter((it) => it.id !== id),
              }))
            }
            renderItem={(item) => {
              const patch = (patchObj: Partial<typeof item>) =>
                update((p) => ({
                  ...p,
                  languages: p.languages.map((it) =>
                    it.id === item.id ? { ...it, ...patchObj } : it,
                  ),
                }));
              return (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <TextField
                    label="言語"
                    value={item.language}
                    onChange={(v) => patch({ language: v })}
                    placeholder="例：英語"
                    suggestions={LANGUAGE_SUGGESTIONS}
                  />
                  <SelectField
                    label="レベル"
                    value={item.level}
                    onChange={(v) => patch({ level: v as typeof item.level })}
                    options={LANGUAGE_LEVELS}
                  />
                </div>
              );
            }}
          />
        </SectionCard>

        {/* ⑬ 趣味・特技 */}
        <SectionCard emoji="🎨" title="趣味・特技">
          <TextareaField
            label="趣味・特技"
            value={activity.hobbies}
            onChange={(v) => setText('hobbies', v)}
            placeholder="打ち込んでいる趣味や、人より得意なことを書いてください。"
          />
        </SectionCard>

        {/* ⑭ 表彰・実績 */}
        <SectionCard emoji="🏆" title="表彰・実績">
          <TextareaField
            label="表彰・実績"
            value={activity.awards}
            onChange={(v) => setText('awards', v)}
            placeholder="例：大会入賞、社内 MVP、コンテスト受賞 など"
          />
        </SectionCard>

        {/* ⑮ SNS・情報発信経験 */}
        <SectionCard
          emoji="📣"
          title="SNS・情報発信経験"
          description={`複数登録できます。例：${SNS_EXAMPLES}`}
        >
          <RepeatableList
            items={activity.snsActivities}
            addLabel="SNS・情報発信を追加"
            emptyHint="運用している/していたアカウントを追加してください。"
            itemLabel={(i) => `SNS・情報発信 ${i + 1}`}
            onAdd={() =>
              update((p) => ({
                ...p,
                snsActivities: [...p.snsActivities, newSnsEntry()],
              }))
            }
            onRemove={(id) =>
              update((p) => ({
                ...p,
                snsActivities: p.snsActivities.filter((it) => it.id !== id),
              }))
            }
            renderItem={(item) => {
              const patch = (patchObj: Partial<typeof item>) =>
                update((p) => ({
                  ...p,
                  snsActivities: p.snsActivities.map((it) =>
                    it.id === item.id ? { ...it, ...patchObj } : it,
                  ),
                }));
              return (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <TextField
                      label="プラットフォーム"
                      value={item.platform}
                      onChange={(v) => patch({ platform: v })}
                      placeholder="例：YouTube / X / note"
                      suggestions={SNS_PLATFORM_SUGGESTIONS}
                    />
                    <TextField
                      label="アカウント名（任意）"
                      value={item.accountName}
                      onChange={(v) => patch({ accountName: v })}
                      placeholder="例：@passai_career"
                    />
                  </div>
                  <TextField
                    label="URL"
                    value={item.url}
                    onChange={(v) => patch({ url: v })}
                    placeholder="https://"
                  />
                  <TextareaField
                    label="内容・テーマ"
                    value={item.theme}
                    onChange={(v) => patch({ theme: v })}
                    placeholder="どんなジャンル・テーマで発信しているかを書いてください。"
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <TextField
                      label="運営期間（開始）"
                      value={item.period.from}
                      onChange={(v) =>
                        patch({ period: { ...item.period, from: v } })
                      }
                      placeholder="2023年4月"
                    />
                    <TextField
                      label="運営期間（終了）"
                      value={item.period.to}
                      onChange={(v) =>
                        patch({ period: { ...item.period, to: v } })
                      }
                      placeholder="現在"
                    />
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <TextField
                      label="フォロワー数・登録者数（任意）"
                      value={item.followers}
                      onChange={(v) => patch({ followers: v })}
                      hint="数字があれば書いてください"
                      placeholder="例：3,000人"
                    />
                    <TextField
                      label="月間PV・再生数など（任意）"
                      value={item.monthlyViews}
                      onChange={(v) => patch({ monthlyViews: v })}
                      hint="数字があれば書いてください"
                      placeholder="例：月10万PV / 月5万再生"
                    />
                  </div>
                  <TextareaField
                    label="一番力を入れたこと"
                    value={item.focusedEffort}
                    onChange={(v) => patch({ focusedEffort: v })}
                    placeholder="伸ばすために工夫したこと・継続のために意識したことなど。"
                  />
                  <TextareaField
                    label="学んだこと"
                    value={item.learning}
                    onChange={(v) => patch({ learning: v })}
                  />
                </>
              );
            }}
          />
        </SectionCard>

        {/* ⑯ ポートフォリオ・制作物 */}
        <SectionCard
          emoji="🗂️"
          title="ポートフォリオ・制作物"
          description={`複数登録できます。例：${PORTFOLIO_EXAMPLES}`}
        >
          <RepeatableList
            items={activity.portfolios}
            addLabel="制作物を追加"
            emptyHint="制作物・ポートフォリオを追加してください。"
            itemLabel={(i) => `制作物 ${i + 1}`}
            onAdd={() =>
              update((p) => ({
                ...p,
                portfolios: [...p.portfolios, newPortfolioEntry()],
              }))
            }
            onRemove={(id) =>
              update((p) => ({
                ...p,
                portfolios: p.portfolios.filter((it) => it.id !== id),
              }))
            }
            renderItem={(item) => {
              const patch = (patchObj: Partial<typeof item>) =>
                update((p) => ({
                  ...p,
                  portfolios: p.portfolios.map((it) =>
                    it.id === item.id ? { ...it, ...patchObj } : it,
                  ),
                }));
              return (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <TextField
                      label="サービス名"
                      value={item.name}
                      onChange={(v) => patch({ name: v })}
                    />
                    <TextField
                      label="制作物の種類"
                      value={item.kind}
                      onChange={(v) => patch({ kind: v })}
                      placeholder="例：Webサイト / アプリ / Figma"
                      suggestions={PORTFOLIO_KIND_SUGGESTIONS}
                    />
                  </div>
                  <TextField
                    label="URL"
                    value={item.url}
                    onChange={(v) => patch({ url: v })}
                    placeholder="https://"
                  />
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <TextField
                      label="使用技術"
                      value={item.techStack}
                      onChange={(v) => patch({ techStack: v })}
                      placeholder="例：React / TypeScript / Figma"
                    />
                    <TextField
                      label="担当"
                      value={item.role}
                      onChange={(v) => patch({ role: v })}
                      placeholder="例：設計・実装 / デザイン"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <TextField
                      label="制作期間（開始）"
                      value={item.period.from}
                      onChange={(v) =>
                        patch({ period: { ...item.period, from: v } })
                      }
                      placeholder="2024年5月"
                    />
                    <TextField
                      label="制作期間（終了）"
                      value={item.period.to}
                      onChange={(v) =>
                        patch({ period: { ...item.period, to: v } })
                      }
                      placeholder="2024年7月"
                    />
                  </div>
                  <TextareaField
                    label="概要"
                    value={item.overview}
                    onChange={(v) => patch({ overview: v })}
                    placeholder="何を解決する/伝える制作物かを書いてください。"
                  />
                  <TextareaField
                    label="工夫したこと"
                    value={item.ingenuity}
                    onChange={(v) => patch({ ingenuity: v })}
                  />
                  <TextareaField
                    label="成果"
                    value={item.result}
                    onChange={(v) => patch({ result: v })}
                    placeholder="数字があれば書いてください。例：利用者100人 / GitHub Star 30"
                  />
                  <TextareaField
                    label="学んだこと"
                    value={item.learning}
                    onChange={(v) => patch({ learning: v })}
                  />
                </>
              );
            }}
          />
        </SectionCard>

        {/* ⑰ 人生経験 */}
        <SectionCard
          emoji="🌱"
          title="人生経験"
          description="自己分析・面接で深掘りされやすいテーマです。書ける範囲で構いません。"
        >
          <div className="space-y-3">
            <TextareaField
              label="一番頑張った経験"
              value={activity.lifeExperiences.hardestEffort}
              onChange={(v) => setObj('lifeExperiences', 'hardestEffort', v)}
            />
            <TextareaField
              label="一番失敗した経験"
              value={activity.lifeExperiences.biggestFailure}
              onChange={(v) => setObj('lifeExperiences', 'biggestFailure', v)}
            />
            <TextareaField
              label="一番嬉しかった経験"
              value={activity.lifeExperiences.happiest}
              onChange={(v) => setObj('lifeExperiences', 'happiest', v)}
            />
            <TextareaField
              label="一番悔しかった経験"
              value={activity.lifeExperiences.mostFrustrated}
              onChange={(v) => setObj('lifeExperiences', 'mostFrustrated', v)}
            />
            <TextareaField
              label="挫折経験"
              value={activity.lifeExperiences.setback}
              onChange={(v) => setObj('lifeExperiences', 'setback', v)}
            />
            <TextareaField
              label="人生の転機"
              value={activity.lifeExperiences.turningPoint}
              onChange={(v) => setObj('lifeExperiences', 'turningPoint', v)}
            />
            <TextareaField
              label="一番成長した経験"
              value={activity.lifeExperiences.mostGrowth}
              onChange={(v) => setObj('lifeExperiences', 'mostGrowth', v)}
            />
          </div>
        </SectionCard>

        {/* ⑱ その他 */}
        <SectionCard emoji="📝" title="その他">
          <TextareaField
            label="その他（自由入力）"
            value={activity.freeNote}
            onChange={(v) => setText('freeNote', v)}
            placeholder="上記に当てはまらない経験・伝えておきたいことを自由に書いてください。"
            rows={4}
          />
        </SectionCard>
      </div>

      {/* 下部固定バー：自動保存の案内 + 完了 */}
      <div className="fixed inset-x-0 bottom-0 border-t border-gray-200 bg-white/95 backdrop-blur px-4 py-3">
        <div className="max-w-3xl mx-auto flex items-center justify-between gap-4">
          <span className="text-sm text-gray-500" aria-live="polite">
            {dirty ? '✓ 入力内容は自動保存されています' : '入力内容は自動保存されます'}
          </span>
          <Link href="/career/home">
            <Button variant="primary" size="md">
              完了してホームへ
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
