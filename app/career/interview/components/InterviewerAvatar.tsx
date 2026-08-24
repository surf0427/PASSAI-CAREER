"use client";

// PASSAI 就活版 — 2D 面接官アバター（SVG）。
//
// 受験版は大学面接官のイラスト PNG を使うが、就活版では素材を持ち込まず（大学面接官らしさを避ける）、
// 軽量な SVG で「企業面接官らしいニュートラルな人物」を描く。
//   - 外部画像 / 3D / Live2D / animation library は使わない（SVG + CSS のみ）。
//   - 性別を強く限定しないデザイン（中庸な髪型・襟のあるジャケット）。
//   - 状態演出（口の開閉・ハロー）は CSS 側（globals.css の .civ-*）が親の
//     [data-state] を見て切り替える。このコンポーネントは形だけを持つ。
//
// 状態（idle / thinking / speaking / listening）の語彙は従来どおり維持する。

export type AvatarState = "idle" | "thinking" | "speaking" | "listening";

/** 状態ごとの短いステータス文言（面接官ステージ右上のピルに出す）。 */
export const AVATAR_STATUS: Record<
  AvatarState,
  { icon: string; label: string }
> = {
  idle: { icon: "💬", label: "回答をどうぞ" },
  thinking: { icon: "🤔", label: "考えています" },
  speaking: { icon: "🎙", label: "質問中" },
  listening: { icon: "👂", label: "回答を聞いています" },
};

/**
 * 2D 面接官の顔（SVG）。サイズは親の CSS（.civ-stage__avatar）が決める。
 * 装飾要素なので aria-hidden。人物の説明はステージ側の role="img" が担う。
 */
export function InterviewerAvatar({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="10 22 200 178"
      className={`civ-avatar ${className}`}
      aria-hidden
      focusable="false"
    >
      {/* 発話中のハロー（CSS で speaking のときだけ animate）。
          ふちが線に見えないよう radial gradient でふわっと消す。 */}
      <defs>
        <radialGradient id="civ-halo-g">
          <stop offset="55%" stopColor="#3b82f6" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#3b82f6" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle
        className="civ-halo"
        cx="110"
        cy="94"
        r="66"
        fill="url(#civ-halo-g)"
        opacity="0"
      />

      {/* 首（この上に襟が重なるので先に描く） */}
      <path d="M96 110h28v42c0 9-28 9-28 0z" fill="#e5b99c" />
      {/* 首の陰（あご下） */}
      <path d="M96 110h28v10c-8 8-20 8-28 0z" fill="#d09f85" opacity="0.7" />

      {/* 上半身（ジャケット） */}
      <path
        d="M110 148c-14 0-24 6-28 16-30 6-56 20-68 36h192c-12-16-38-30-68-36-4-10-14-16-28-16z"
        fill="#334155"
      />
      {/* 白シャツ（V ゾーン） */}
      <path d="M90 147h40l-15 53h-10z" fill="#f8fafc" />
      {/* ラペル（襟の返し・わずかに明るく） */}
      <path d="M90 153l17 47h-8l-14-40z" fill="#42536b" />
      <path d="M130 153l-17 47h8l14-40z" fill="#42536b" />
      {/* シャツの襟先 */}
      <path d="M97 147l13 27-21-14-1-13z" fill="#e9eff7" />
      <path d="M123 147l-13 27 21-14 1-13z" fill="#f4f8fc" />
      {/* 耳 */}
      <ellipse cx="66" cy="96" rx="7" ry="11" fill="#eec3a8" />
      <ellipse cx="154" cy="96" rx="7" ry="11" fill="#eec3a8" />

      {/* 頭 */}
      <ellipse cx="110" cy="92" rx="44" ry="50" fill="#f2cdb2" />

      {/* 髪（性別を限定しないニュートラルな短め〜ミディアム） */}
      <path
        d="M66 96c-5-38 16-56 44-56s49 18 44 56c-3-20-13-32-44-32s-41 12-44 32z"
        fill="#3a4351"
      />
      <path d="M67 98c-1-10-1-18 1-25 4 10 4 19 3 27z" fill="#2f3742" />
      <path d="M153 98c1-10 1-18-1-25-4 10-4 19-3 27z" fill="#2f3742" />

      {/* 眉 */}
      <path
        d="M85 80q10-4.5 19 0M116 80q9-4.5 19 0"
        stroke="#333c49"
        strokeWidth="2.6"
        strokeLinecap="round"
        fill="none"
      />

      {/* 目 */}
      <ellipse className="civ-eye" cx="94" cy="95" rx="4.4" ry="5.4" fill="#1e293b" />
      <ellipse className="civ-eye" cx="126" cy="95" rx="4.4" ry="5.4" fill="#1e293b" />

      {/* 鼻（小鼻を示す控えめな一本線） */}
      <path
        d="M104 109q6 4.5 12 0"
        stroke="#dda98d"
        strokeWidth="2.4"
        strokeLinecap="round"
        fill="none"
      />

      {/* 口（speaking のとき CSS で開閉する） */}
      <ellipse className="civ-mouth" cx="110" cy="122" rx="10" ry="3" fill="#b4675c" />
    </svg>
  );
}
