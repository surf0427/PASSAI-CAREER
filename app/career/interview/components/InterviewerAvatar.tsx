"use client";

// PASSAI 就活版 — 2D 面接官アバター（SVG）。
//
// 受験版は大学面接官のイラスト PNG を使うが、就活版では素材を持ち込まず（大学面接官らしさを避ける）、
// 軽量な SVG で「若手の女性面接官」を描く。面接練習の心理的ハードルを下げるため、
// 清潔感・信頼感を保ったまま親しみやすい表情に寄せている（萌え絵化・過度な装飾はしない）。
//   - 外部画像 / 3D / Live2D / animation library は使わない（SVG + CSS のみ）。
//   - 状態演出（口の開閉・ハロー・まばたき）は CSS 側（globals.css の .civ-*）が親の
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

// 配色（既存の blue パレットに馴染ませる。肌・髪はやや暖色寄りで柔らかく）。
const SKIN = "#f8d8c0";
const SKIN_SHADE = "#e8b79c";
const HAIR = "#4a3a32";
const JACKET = "#3a5183";
const LAPEL = "#4a659b";
const BLOUSE = "#fbfcfe";

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
      <defs>
        {/* 発話中のハロー。ふちが線に見えないよう radial gradient でふわっと消す。 */}
        <radialGradient id="civ-halo-g">
          <stop offset="52%" stopColor="#60a5fa" stopOpacity="0.26" />
          <stop offset="100%" stopColor="#60a5fa" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle
        className="civ-halo"
        cx="110"
        cy="96"
        r="72"
        fill="url(#civ-halo-g)"
        opacity="0"
      />

      {/* 後ろ髪（内巻きのセミロングボブ。頭・肩より奥に置く）。
          頬のあたりで最も広く、毛先が内側へ入るシルエットで柔らかい印象を作る。 */}
      <path
        d="M110 30C153 30 167 61 164 100C163 125 168 148 173 164C163 178 144 177 138 162C136 170 135 178 135 186H85C85 178 84 170 82 162C76 177 57 178 47 164C52 148 57 125 56 100C53 61 67 30 110 30Z"
        fill={HAIR}
      />

      {/* 首（この上に襟が重なるので先に描く） */}
      <path d="M98 112h24v34c0 9-24 9-24 0z" fill={SKIN} />
      <path d="M98 112h24v10c-7 8-17 8-24 0z" fill={SKIN_SHADE} opacity="0.7" />

      {/* 上半身（ネイビージャケット。肩はやや華奢に） */}
      <path
        d="M110 144c-16 0-27 8-31 19-27 6-50 19-61 37h184c-11-18-34-31-61-37-4-11-15-19-31-19z"
        fill={JACKET}
      />
      {/* インナー（明るいブラウス・丸みのあるやさしい襟ぐり） */}
      <path d="M95 147c2 14 7 24 15 27 8-3 13-13 15-27z" fill={BLOUSE} />
      {/* ラペル（襟の返し・わずかに明るく） */}
      <path d="M95 147c2 15 7 26 15 29l-4 7-19-32z" fill={LAPEL} />
      <path d="M125 147c-2 15-7 26-15 29l4 7 19-32z" fill={LAPEL} />

      {/* 顔（やわらかい丸みの輪郭・あご先はゆるく細く） */}
      <path
        d="M110 46c26 0 43 19 43 45 0 27-19 48-43 48s-43-21-43-48c0-26 17-45 43-45z"
        fill={SKIN}
      />

      {/* 顔まわりの毛束（内巻きの毛先で顔をやわらかく包む） */}
      <path
        d="M146 60c8 24 9 48 7 71-1 9-5 15-10 18-6 3-12 0-14-5 7-7 10-18 10-31 0-18-1-36-5-53z"
        fill={HAIR}
      />
      <path
        d="M74 60c-8 24-9 48-7 71 1 9 5 15 10 18 6 3 12 0 14-5-7-7-10-18-10-31 0-18 1-36 5-53z"
        fill={HAIR}
      />

      {/* 前髪（軽く横へ流したサイドパート。おでこを自然に覆う） */}
      <path
        d="M67 98C63 58 82 38 110 38s47 20 43 60c-2-22-6-34-23-38-10 14-20 20-32 19-10-1-17 5-21 19z"
        fill={HAIR}
      />

      {/* 眉（細めのやわらかいアーチ） */}
      <path
        d="M86 86q9.5-5.5 18-1M118 85q8.5-4.5 18 1"
        stroke="#4a3a32"
        strokeWidth="2.1"
        strokeLinecap="round"
        fill="none"
      />

      {/* 目（まばたきは CSS。白目 + 虹彩 + ハイライトで生き生きと見せる） */}
      <g className="civ-eye" style={{ transformOrigin: "93px 101px" }}>
        <ellipse cx="93" cy="101" rx="8" ry="6.6" fill="#ffffff" />
        <circle cx="93" cy="101.5" r="5.1" fill="#4b3a30" />
        <circle cx="93" cy="101.5" r="2.3" fill="#241c17" />
        <circle cx="95.4" cy="99" r="1.9" fill="#ffffff" opacity="0.95" />
        <path
          d="M84 98q9-7 18-1"
          stroke="#33251e"
          strokeWidth="2.6"
          strokeLinecap="round"
          fill="none"
        />
      </g>
      <g className="civ-eye" style={{ transformOrigin: "127px 101px" }}>
        <ellipse cx="127" cy="101" rx="8" ry="6.6" fill="#ffffff" />
        <circle cx="127" cy="101.5" r="5.1" fill="#4b3a30" />
        <circle cx="127" cy="101.5" r="2.3" fill="#241c17" />
        <circle cx="129.4" cy="99" r="1.9" fill="#ffffff" opacity="0.95" />
        <path
          d="M118 97q9-6 18 1"
          stroke="#33251e"
          strokeWidth="2.6"
          strokeLinecap="round"
          fill="none"
        />
      </g>

      {/* 頬（ごく薄いチーク。派手にしない） */}
      <ellipse cx="80" cy="114" rx="7.5" ry="4.4" fill="#f0a08f" opacity="0.3" />
      <ellipse
        cx="140"
        cy="114"
        rx="7.5"
        ry="4.4"
        fill="#f0a08f"
        opacity="0.3"
      />

      {/* 鼻（控えめな一本線） */}
      <path
        d="M106 115q4.5 3.5 9 0"
        stroke={SKIN_SHADE}
        strokeWidth="2.2"
        strokeLinecap="round"
        fill="none"
      />

      {/* 口（軽い微笑み。speaking のとき CSS で開閉する） */}
      <path
        className="civ-mouth"
        d="M101 124q9 9 18 0q-9 5-18 0z"
        fill="#c26a63"
      />
    </svg>
  );
}
