// PASSAI 就活版 — GD「Forest Circle」の背景と共有シェーディング定義（PASSAI オリジナル）。
//
// 方針:
//   - 画像 / 動画 / WebGL / canvas / 3D エンジンを使わない。SVG のパスとグラデーションだけで
//     「立体的な空間」に見せる（静止画的・軽量）。
//   - 3D 感の作り方は 4 つ:
//       ① レイヤー分割（遠景→中景→近景）と空気遠近（奥ほど淡く・明るく・低コントラスト）
//       ② 地面を「面」として描く（楕円の床＋同心リング＋接地ハイライト）
//       ③ 光源を 1 つに固定（上手前やや左）し、幹のリムライトと光芒で方向を示す
//       ④ ビネットで四隅を落として中央に奥行きを作る
//   - ランダムは使わない（SSR/CSR で同じ DOM になる）。
//
// ★ <defs> にある gdf* グラデーションは **参加者アバター（ParticipantAvatar）からも参照する**。
//   SVG の参照は document 単位で解決されるため、ステージ 1 枚につきここで 1 度定義すれば足りる。
//   いずれも「白/黒のアルファのみ」なので、どの基本色の上に重ねても陰影として成立する。

type Tree = { x: number; base: number; w: number; h: number };

// 遠景（地平線の上に小さく並ぶ・淡い）。
const FAR_TREES: Tree[] = [
  { x: 40, base: 116, w: 78, h: 104 },
  { x: 150, base: 118, w: 66, h: 84 },
  { x: 248, base: 117, w: 84, h: 112 },
  { x: 356, base: 118, w: 62, h: 78 },
  { x: 452, base: 117, w: 74, h: 96 },
  { x: 556, base: 118, w: 64, h: 82 },
  { x: 660, base: 117, w: 80, h: 106 },
  { x: 764, base: 118, w: 68, h: 86 },
  { x: 868, base: 117, w: 78, h: 100 },
  { x: 972, base: 118, w: 66, h: 84 },
  { x: 1070, base: 117, w: 82, h: 108 },
  { x: 1168, base: 118, w: 70, h: 88 },
];

// 樹冠（丸みのある広葉樹シルエット）。
function canopy(t: Tree): string {
  const half = t.w / 2;
  return [
    `M${t.x - half} ${t.base}`,
    `C${t.x - half * 1.02} ${t.base - t.h * 0.6} ${t.x - half * 0.68} ${t.base - t.h * 0.98} ${t.x} ${t.base - t.h * 0.98}`,
    `C${t.x + half * 0.68} ${t.base - t.h * 0.98} ${t.x + half * 1.02} ${t.base - t.h * 0.6} ${t.x + half} ${t.base}`,
    'Z',
  ].join(' ');
}

// 中景〜近景の幹（地平線の奥から画面上端の樹冠へ伸びる）。太さ・濃さで距離を表す。
const TRUNKS: { x: number; w: number; top: number; base: number; fill: string; lit?: string }[] = [
  { x: 168, w: 13, top: 8, base: 140, fill: '#0c2a20', lit: '#1c4633' },
  { x: 296, w: 8, top: 26, base: 132, fill: '#123527' },
  { x: 402, w: 16, top: 0, base: 146, fill: '#081f18', lit: '#173c2c' },
  { x: 528, w: 9, top: 20, base: 134, fill: '#0f2f23' },
  { x: 668, w: 11, top: 12, base: 140, fill: '#0b2820', lit: '#1a4230' },
  { x: 792, w: 8, top: 28, base: 132, fill: '#123527' },
  { x: 902, w: 15, top: 0, base: 146, fill: '#081f18', lit: '#173c2c' },
  { x: 1034, w: 10, top: 16, base: 136, fill: '#0e2d22' },
];

/** 画面上端を覆う樹冠のかたまり（森の奥行きを「面」で見せる）。 */
const CANOPY_MASS =
  'M0 0 H1200 V62 C1150 96 1104 60 1052 84 C1006 106 962 66 916 88 C872 108 828 62 782 84 ' +
  'C738 104 692 64 648 86 C604 106 560 60 516 82 C472 102 428 62 384 84 C340 104 296 64 252 86 ' +
  'C208 106 164 60 118 82 C74 102 40 70 0 88 Z';

function TreeRow({
  trees,
  fill,
  trunk,
  lit,
}: {
  trees: Tree[];
  fill: string;
  trunk: string;
  /** 光の当たる側（左上）に入れるハイライト色。奥行きの手掛かりになる。 */
  lit?: string;
}) {
  return (
    <g>
      {trees.map((t) => (
        <g key={`${fill}-${t.x}`}>
          <rect x={t.x - t.w * 0.06} y={t.base - 40} width={t.w * 0.12} height="72" rx="5" fill={trunk} />
          <path d={canopy(t)} fill={fill} />
          {lit && (
            <path
              d={`M${t.x - t.w * 0.5} ${t.base} Q${t.x - t.w * 0.49} ${t.base - t.h * 0.52} ${t.x - t.w * 0.26} ${t.base - t.h * 0.76} L${t.x - t.w * 0.1} ${t.base - t.h * 0.66} Q${t.x - t.w * 0.34} ${t.base - t.h * 0.44} ${t.x - t.w * 0.36} ${t.base} Z`}
              fill={lit}
              opacity="0.5"
            />
          )}
        </g>
      ))}
    </g>
  );
}

export function ForestBackdrop() {
  return (
    <svg
      className="gdf-backdrop"
      viewBox="0 0 1200 620"
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        {/* ── 空・地面・霧 ───────────────────────────────── */}
        <linearGradient id="gdfSky" x1="0" y1="0" x2="0" y2="0.34">
          <stop offset="0%" stopColor="#061a17" />
          <stop offset="45%" stopColor="#10352b" />
          <stop offset="100%" stopColor="#276a4e" />
        </linearGradient>
        <linearGradient id="gdfGround" x1="0" y1="0.24" x2="0" y2="1">
          <stop offset="0%" stopColor="#3a6142" />
          <stop offset="26%" stopColor="#2c4a34" />
          <stop offset="100%" stopColor="#132218" />
        </linearGradient>
        <linearGradient id="gdfFog" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#cfeeda" stopOpacity="0" />
          <stop offset="50%" stopColor="#dcf4e6" stopOpacity="0.26" />
          <stop offset="100%" stopColor="#cfeeda" stopOpacity="0" />
        </linearGradient>
        <radialGradient id="gdfDusk" cx="50%" cy="100%" r="62%">
          <stop offset="0%" stopColor="#ffd9a1" stopOpacity="0.42" />
          <stop offset="55%" stopColor="#f5b877" stopOpacity="0.15" />
          <stop offset="100%" stopColor="#f5b877" stopOpacity="0" />
        </radialGradient>
        {/* 円卓が置かれた「床」。中央が明るく、外周へ落ちる＝面の丸みを出す。 */}
        <radialGradient id="gdfFloor" cx="50%" cy="40%" r="58%">
          <stop offset="0%" stopColor="#ffdcab" stopOpacity="0.36" />
          <stop offset="42%" stopColor="#eec38b" stopOpacity="0.16" />
          <stop offset="100%" stopColor="#c99a63" stopOpacity="0" />
        </radialGradient>
        {/* 四隅を落として中央に奥行きを作る（3D 感で最も効く）。 */}
        <radialGradient id="gdfVignette" cx="50%" cy="52%" r="72%">
          <stop offset="55%" stopColor="#000000" stopOpacity="0" />
          <stop offset="100%" stopColor="#00120c" stopOpacity="0.55" />
        </radialGradient>

        {/* ── 参加者アバター共有シェーディング（アルファのみ） ─────────
            ParticipantAvatar が url(#gdfSphere) 等で参照する。基本色の上に重ねるだけで
            球・円柱・平面の陰影になるため、参加者ごとにグラデーションを増やさずに済む。 */}
        <radialGradient id="gdfSphere" cx="34%" cy="26%" r="76%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.42" />
          <stop offset="38%" stopColor="#ffffff" stopOpacity="0.06" />
          <stop offset="72%" stopColor="#000000" stopOpacity="0.1" />
          <stop offset="100%" stopColor="#00160f" stopOpacity="0.4" />
        </radialGradient>
        <linearGradient id="gdfVert" x1="0" y1="0" x2="0.15" y2="1">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.2" />
          <stop offset="48%" stopColor="#ffffff" stopOpacity="0.02" />
          <stop offset="100%" stopColor="#00160f" stopOpacity="0.34" />
        </linearGradient>
        <linearGradient id="gdfSide" x1="0" y1="0.1" x2="1" y2="0.3">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.18" />
          <stop offset="42%" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="100%" stopColor="#00160f" stopOpacity="0.34" />
        </linearGradient>
        {/* 接地影（足元・椅子脚の下）。 */}
        <radialGradient id="gdfContact" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#03110b" stopOpacity="0.62" />
          <stop offset="62%" stopColor="#03110b" stopOpacity="0.2" />
          <stop offset="100%" stopColor="#03110b" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* 空（木々の隙間から差す夕暮れ）。地平線が高いので空の帯は狭い。 */}
      <rect x="0" y="0" width="1200" height="620" fill="url(#gdfSky)" />
      <ellipse cx="600" cy="130" rx="620" ry="120" fill="url(#gdfDusk)" />

      {/* 光芒（光源の方向を示す。ごく淡く 2 本だけ） */}
      <g fill="#ffeccd" opacity="0.035">
        <path d="M430 0 L500 0 L392 240 L300 240 Z" />
        <path d="M712 0 L756 0 L700 240 L640 240 Z" />
      </g>

      {/* 遠景の小さな木（地平線の上に点在。淡く低コントラスト＝遠い） */}
      <TreeRow trees={FAR_TREES} fill="#22563f" trunk="#1d4837" lit="#2f7455" />
      {/* 中景の幹（奥から手前へ。太く濃いほど手前） */}
      <g>
        {TRUNKS.map((t) => (
          <g key={`trunk-${t.x}`}>
            <path
              d={`M${t.x - t.w / 2} ${t.top} L${t.x + t.w / 2} ${t.top} L${t.x + t.w / 2 + 1.5} ${t.base} L${t.x - t.w / 2 - 1.5} ${t.base} Z`}
              fill={t.fill}
            />
            {t.lit && (
              <path
                d={`M${t.x - t.w / 2} ${t.top} L${t.x - t.w / 2 + 3} ${t.top} L${t.x - t.w / 2 + 1.5} ${t.base} L${t.x - t.w / 2 - 1.5} ${t.base} Z`}
                fill={t.lit}
                opacity="0.6"
              />
            )}
          </g>
        ))}
      </g>
      {/* 画面上端を覆う樹冠（森の中にいる感じを出す） */}
      <path d={CANOPY_MASS} fill="#071d16" />
      <path d={CANOPY_MASS} fill="url(#gdfVert)" opacity="0.5" />
      {/* 樹冠の下端の葉むら（等間隔の波に見えないよう崩す） */}
      <g fill="#0a2419">
        <ellipse cx="92" cy="92" rx="46" ry="24" />
        <ellipse cx="318" cy="100" rx="58" ry="26" />
        <ellipse cx="470" cy="86" rx="40" ry="20" />
        <ellipse cx="706" cy="98" rx="52" ry="24" />
        <ellipse cx="880" cy="88" rx="38" ry="19" />
        <ellipse cx="1096" cy="96" rx="56" ry="25" />
      </g>

      {/* ── 地面（高い地平線。すべての参加者がこの面の上に立つ）────────── */}
      <path d="M0 152 Q300 126 600 130 Q900 126 1200 152 L1200 620 L0 620 Z" fill="url(#gdfGround)" />
      {/* 地平線のハイライト（面の境目を立たせる） */}
      <path
        d="M0 152 Q300 126 600 130 Q900 126 1200 152"
        fill="none"
        stroke="#5d8f68"
        strokeWidth="2.5"
        opacity="0.35"
      />
      {/* 地平線の霧（遠景と床の分離＝奥行きが最も出る要素） */}
      <rect x="0" y="104" width="1200" height="104" fill="url(#gdfFog)" />

      {/* 円卓が置かれた明るい床（手前ほど広がる楕円＝透視） */}
      <ellipse cx="600" cy="430" rx="560" ry="230" fill="url(#gdfFloor)" />
      {/* 床の同心リング（透視方向の手掛かり。ごく淡く） */}
      <g fill="none" stroke="#d9ecc9" opacity="0.022">
        <ellipse cx="600" cy="436" rx="392" ry="158" strokeWidth="2" />
      </g>

      {/* 手前の幹（左右のフレーミング）。根元が画面下寄り＝カメラに近い。 */}
      <g>
        <path d="M2 0 h86 q-14 180 -8 340 q6 148 14 280 h-98 q12 -160 14 -318 q4 -152 -8 -302 Z" fill="#06140f" />
        <path d="M60 0 h28 q-13 180 -7 340 q6 148 13 280 h-30 q-7 -160 -11 -320 q-4 -152 7 -300 Z" fill="#123024" />
        <path d="M80 0 h8 q-13 180 -7 340 q6 148 13 280 h-9 q-7 -160 -11 -320 q-4 -152 6 -300 Z" fill="#2a5c42" opacity="0.5" />
        <path d="M66 196 q56 -22 98 -66 q-28 64 -94 94 Z" fill="#06140f" />
        <path d="M1112 0 h88 q-14 184 -8 344 q6 146 14 276 h-100 q12 -158 14 -320 q4 -152 -8 -300 Z" fill="#06140f" />
        <path d="M1112 0 h26 q-11 184 -5 344 q6 146 12 276 h-28 q-7 -158 -11 -322 q-4 -150 6 -298 Z" fill="#123024" />
        <path d="M1112 0 h8 q-11 184 -5 344 q6 146 12 276 h-9 q-7 -158 -11 -322 q-4 -150 5 -298 Z" fill="#2a5c42" opacity="0.4" />
        <path d="M1108 236 q-58 -20 -104 -62 q34 64 100 88 Z" fill="#06140f" />
      </g>

      {/* 下草（手前ほど大きい＝遠近） */}
      <g fill="#3d6747" opacity="0.45">
        <path d="M212 214 q9 -20 18 0 z" />
        <path d="M980 216 q9 -20 18 0 z" />
        <path d="M150 476 q16 -34 32 0 z" opacity="0.9" />
        <path d="M1032 486 q17 -36 34 0 z" opacity="0.9" />
        <path d="M320 578 q19 -40 38 0 z" opacity="0.75" />
        <path d="M880 588 q19 -40 38 0 z" opacity="0.75" />
      </g>

      {/* ビネット（最後に重ねて中央へ視線を集める） */}
      <rect x="0" y="0" width="1200" height="620" fill="url(#gdfVignette)" />
    </svg>
  );
}
