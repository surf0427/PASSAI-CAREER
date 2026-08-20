'use client';

// PASSAI CAREER — マイページの User Data Spine 表示セクション（presentation layer のみ）。
//
// 責務: buildMypageSpineView が組んだ view model を描画するだけ。
//   計算・整形・fallback は一切持たない（判断は純関数側に閉じる）。
//
// 表示ポリシー（要件 5）:
//   - raw prompt / system prompt / 内部 instruction / hidden metadata は出さない。
//   - 出すのは Layer 2 payload の typed field を人間の言葉へ翻訳したものだけ。
//   - 実データが無い項目は行ごと出さない（ダミー AI コメントを作らない）。

import Link from 'next/link';
import { Card } from '@/components/ui/Card';
import { LinkButton } from '@/components/ui/LinkButton';
import type {
  CompletenessItem,
  SpineExperienceView,
  SpineFact,
  SpineSelfAnalysisView,
} from './mypageDataSpineView';

function formatYmd(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}

// ── Section B: PASSAI が理解しているあなた ───────────────────────────

export function UnderstandingSection({ facts }: { facts: SpineFact[] }) {
  return (
    <section>
      <div className="mb-3">
        <h2 className="text-lg font-bold text-slate-900">PASSAIが理解しているあなた</h2>
        <p className="mt-1 text-sm text-slate-600 leading-relaxed">
          自己分析・活動整理・就活軸・練習履歴からまとめた内容です。
          ES・面接・プレゼン・GD・企業分析など、すべてのAI機能がこの内容を前提に回答します。
        </p>
      </div>

      {facts.length === 0 ? (
        <Card variant="soft" padding="md">
          <p className="text-sm text-gray-700 leading-relaxed">
            まだあなたのことを十分に把握できていません。
            自己分析や就活軸整理を進めると、ここにPASSAIの理解が表示されます。
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <LinkButton href="/career/self-analysis" variant="primary" size="sm">
              自己分析へ
            </LinkButton>
            <LinkButton href="/career/values" variant="outline" size="sm">
              就活軸整理へ
            </LinkButton>
          </div>
        </Card>
      ) : (
        <Card variant="default" padding="md">
          <dl className="space-y-4">
            {facts.map((f) => (
              <div key={f.key}>
                <dt className="text-xs font-semibold text-gray-500 mb-1">
                  {f.label}
                  <span className="ml-2 font-normal text-gray-400">{f.origin}より</span>
                </dt>
                <dd className="flex flex-wrap gap-1.5">
                  {f.values.map((v) => (
                    <span
                      key={v}
                      className="inline-flex items-center rounded-lg bg-brand-50 px-2.5 py-1 text-sm text-brand-800 ring-1 ring-brand-100"
                    >
                      {v}
                    </span>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 text-xs text-gray-400 leading-relaxed">
            ここに出る内容は直接編集できません。元になったデータ（自己分析・就活軸整理・活動整理）
            を更新すると、この理解も自動で作り直されます。
          </p>
        </Card>
      )}
    </section>
  );
}

// ── Section C: 経験・活動 ────────────────────────────────────────────

export function ExperienceSection({ experience }: { experience: SpineExperienceView }) {
  const empty = experience.sections.length === 0 && experience.highlights.length === 0;
  return (
    <section>
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="text-lg font-bold text-slate-900">経験・活動</h2>
        <Link
          href="/career/activity"
          className="text-sm font-medium text-brand-600 hover:text-brand-700 transition-colors"
        >
          活動整理へ →
        </Link>
      </div>
      <Card variant="default" padding="md">
        {empty ? (
          <p className="text-sm text-gray-600 leading-relaxed">
            ガクチカ・アルバイト・インターン・趣味・表彰などを登録すると、
            ESや面接でAIがあなたの経験を使えるようになります。
          </p>
        ) : (
          <div className="space-y-4">
            {experience.highlights.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold text-gray-500 mb-1.5">主な取り組み</h3>
                <ul className="space-y-1">
                  {experience.highlights.map((h) => (
                    <li key={h} className="text-sm text-slate-800">
                      ・{h}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {experience.sections.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold text-gray-500 mb-1.5">登録済みのカテゴリ</h3>
                <div className="flex flex-wrap gap-1.5">
                  {experience.sections.map((s) => (
                    <span
                      key={s}
                      className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-0.5 text-sm text-slate-700"
                    >
                      {s}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Card>
    </section>
  );
}

// ── Section D: 自己分析（現在の canonical 結果のみ） ─────────────────

export function SelfAnalysisSection({ view }: { view: SpineSelfAnalysisView | null }) {
  return (
    <section>
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="text-lg font-bold text-slate-900">自己分析</h2>
        <Link
          href="/career/self-analysis"
          className="text-sm font-medium text-brand-600 hover:text-brand-700 transition-colors"
        >
          自己分析へ →
        </Link>
      </div>
      <Card variant="default" padding="md">
        {!view ? (
          <p className="text-sm text-gray-600 leading-relaxed">
            まだ自己分析の結果がありません。AIとの対話で、強み・価値観・向かいたい方向を整理できます。
          </p>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-gray-400">
              最終更新 {formatYmd(view.createdAt)}
              {view.totalCount > 1 && `・全${view.totalCount}件`}
            </p>
            {view.summary && (
              <p className="text-sm text-slate-800 leading-relaxed">{view.summary}</p>
            )}
            {view.careerDirection && (
              <div>
                <h3 className="text-xs font-semibold text-gray-500 mb-1">今後の方向性</h3>
                <p className="text-sm text-slate-800 leading-relaxed">{view.careerDirection}</p>
              </div>
            )}
            {view.nextActions.length > 0 && (
              <div>
                <h3 className="text-xs font-semibold text-gray-500 mb-1">次のアクション</h3>
                <ul className="space-y-1">
                  {view.nextActions.map((a) => (
                    <li key={a} className="text-sm text-slate-800">
                      ・{a}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </Card>
    </section>
  );
}

// ── データの充実度（決定論・実 canonical data 由来） ──────────────────

export function CompletenessSection({
  items,
  done,
}: {
  items: CompletenessItem[];
  done: number;
}) {
  return (
    <section>
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="text-lg font-bold text-slate-900">データの充実度</h2>
        <span className="text-sm text-gray-500">
          {done} / {items.length}
        </span>
      </div>
      <Card variant="default" padding="md">
        <ul className="divide-y divide-slate-100">
          {items.map((item) => (
            <li key={item.key} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
              <span className="text-sm font-medium text-slate-800">{item.label}</span>
              <span className="flex items-center gap-3">
                {item.detail && <span className="text-xs text-gray-400">{item.detail}</span>}
                {item.filled ? (
                  <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200">
                    登録済み
                  </span>
                ) : (
                  <Link
                    href={item.href}
                    className="text-xs font-medium px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 hover:bg-gray-200 transition-colors"
                  >
                    未入力
                  </Link>
                )}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-gray-400 leading-relaxed">
          登録された内容がそのままAIの前提情報になります。埋まっているほど、
          ES・面接・企業分析の精度が上がります。
        </p>
      </Card>
    </section>
  );
}
