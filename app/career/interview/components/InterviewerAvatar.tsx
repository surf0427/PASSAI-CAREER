'use client';

// PASSAI 就活版 — 面接官アバター（企業面接官らしい簡易表示）。
//
// 受験版は大学面接官のイラスト PNG を使うが、就活版では素材を持ち込まず（大学面接官らしさを避ける）、
// 企業面接官らしい絵文字 + 役割ラベル + 状態インジケータで表現する（仮表示）。
// 状態（idle / thinking / speaking / listening）に応じてキャプションと波形アニメを切り替える。

export type AvatarState = 'idle' | 'thinking' | 'speaking' | 'listening';

const CAPTION: Record<AvatarState, string> = {
  idle: '回答をどうぞ',
  thinking: '🤔 面接官が考えています…',
  speaking: '🗣️ 質問しています…',
  listening: '👂 回答を聞いています…',
};

export function InterviewerAvatar({
  role,
  modeLabel,
  state,
}: {
  role: string;
  modeLabel: string;
  state: AvatarState;
}) {
  const ring =
    state === 'speaking'
      ? 'ring-blue-400'
      : state === 'listening'
        ? 'ring-emerald-400'
        : state === 'thinking'
          ? 'ring-amber-300'
          : 'ring-slate-200';
  const active = state === 'speaking' || state === 'listening';
  const barColor = state === 'listening' ? 'bg-emerald-500' : 'bg-blue-500';

  return (
    <div className="flex items-center gap-4">
      <div
        className={`flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-slate-100 ring-2 ${ring} transition-colors`}
        aria-hidden
      >
        <span className="text-3xl">🧑‍💼</span>
      </div>
      <div className="min-w-0">
        <p className="text-sm font-bold text-slate-900">
          {role}
          <span className="ml-2 text-[11px] font-medium text-slate-400">
            {modeLabel}
          </span>
        </p>
        <div className="mt-1 flex items-center gap-2">
          <p className="text-xs text-slate-500">{CAPTION[state]}</p>
          {active && (
            <span className="flex items-end gap-0.5" aria-hidden>
              {[0, 1, 2, 3, 4].map((i) => (
                <span
                  key={i}
                  className={`w-0.5 rounded-full ${barColor} animate-pulse`}
                  style={{
                    height: `${6 + ((i * 5) % 12)}px`,
                    animationDelay: `${i * 0.12}s`,
                  }}
                />
              ))}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
