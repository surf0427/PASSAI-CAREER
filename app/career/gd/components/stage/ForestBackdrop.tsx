// PASSAI 就活版 — GD「Forest Circle」の背景（PASSAI オリジナルの SVG / CSS のみ）。
//
// 方針:
//   - 画像 / 動画 / WebGL / canvas を使わない（GD 中は AI・realtime が動くため UI は軽量に保つ）。
//   - 形はすべてパスで生成する。ランダムは使わない（SSR/CSR で同じ DOM になる）。
//   - 奥（明るい）→ 手前（暗い）の空気遠近で「森の奥行き」を出しつつ、
//     地面〜中央は暖色で明るくして UI と人物の視認性を確保する。

type Tree = { x: number; base: number; w: number; h: number };

// 奥の樹林（小さく明るい）。
const FAR_TREES: Tree[] = [
  { x: 60, base: 388, w: 96, h: 176 },
  { x: 186, base: 392, w: 82, h: 148 },
  { x: 300, base: 390, w: 104, h: 190 },
  { x: 430, base: 392, w: 78, h: 140 },
  { x: 560, base: 390, w: 92, h: 166 },
  { x: 690, base: 392, w: 80, h: 146 },
  { x: 812, base: 390, w: 100, h: 184 },
  { x: 942, base: 392, w: 84, h: 152 },
  { x: 1064, base: 390, w: 96, h: 172 },
  { x: 1170, base: 392, w: 86, h: 150 },
];

// 中景の樹林（大きく暗い）。
const MID_TREES: Tree[] = [
  { x: 124, base: 402, w: 150, h: 268 },
  { x: 322, base: 406, w: 132, h: 232 },
  { x: 520, base: 404, w: 118, h: 206 },
  { x: 700, base: 406, w: 126, h: 224 },
  { x: 880, base: 404, w: 146, h: 262 },
  { x: 1076, base: 406, w: 134, h: 236 },
];

// 樹冠（丸みのある広葉樹シルエット）。
function canopy(t: Tree): string {
  const half = t.w / 2;
  return [
    `M${t.x - half} ${t.base}`,
    `Q${t.x - half * 0.98} ${t.base - t.h * 0.52} ${t.x - half * 0.52} ${t.base - t.h * 0.76}`,
    `Q${t.x} ${t.base - t.h * 1.06} ${t.x + half * 0.52} ${t.base - t.h * 0.76}`,
    `Q${t.x + half * 0.98} ${t.base - t.h * 0.52} ${t.x + half} ${t.base}`,
    'Z',
  ].join(' ');
}

function TreeRow({ trees, fill, trunk }: { trees: Tree[]; fill: string; trunk: string }) {
  return (
    <g>
      {trees.map((t) => (
        <g key={`${fill}-${t.x}`}>
          <rect x={t.x - t.w * 0.06} y={t.base - 40} width={t.w * 0.12} height="70" rx="5" fill={trunk} />
          <path d={canopy(t)} fill={fill} />
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
        <linearGradient id="gdf-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#08201c" />
          <stop offset="38%" stopColor="#123a2e" />
          <stop offset="72%" stopColor="#1d5641" />
          <stop offset="100%" stopColor="#2a6b4e" />
        </linearGradient>
        <linearGradient id="gdf-ground" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#33553b" />
          <stop offset="45%" stopColor="#284433" />
          <stop offset="100%" stopColor="#182c20" />
        </linearGradient>
        <linearGradient id="gdf-fog" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#cfeeda" stopOpacity="0" />
          <stop offset="50%" stopColor="#d8f2e2" stopOpacity="0.2" />
          <stop offset="100%" stopColor="#cfeeda" stopOpacity="0" />
        </linearGradient>
        <radialGradient id="gdf-dusk" cx="50%" cy="100%" r="62%">
          <stop offset="0%" stopColor="#ffd9a1" stopOpacity="0.4" />
          <stop offset="55%" stopColor="#f5b877" stopOpacity="0.14" />
          <stop offset="100%" stopColor="#f5b877" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="gdf-clearing" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#ffd79a" stopOpacity="0.26" />
          <stop offset="62%" stopColor="#ffc98a" stopOpacity="0.09" />
          <stop offset="100%" stopColor="#ffc98a" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="gdf-canopyLight" cx="50%" cy="0%" r="72%">
          <stop offset="0%" stopColor="#dff3d8" stopOpacity="0.16" />
          <stop offset="100%" stopColor="#dff3d8" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* 空（木々のあいだから見える夕暮れ） */}
      <rect x="0" y="0" width="1200" height="620" fill="url(#gdf-sky)" />
      <rect x="0" y="0" width="1200" height="300" fill="url(#gdf-canopyLight)" />
      <ellipse cx="600" cy="392" rx="560" ry="180" fill="url(#gdf-dusk)" />

      {/* 樹林（奥は明るく／中景は暗く＝空気遠近） */}
      <TreeRow trees={FAR_TREES} fill="#1a4636" trunk="#173c2f" />
      <TreeRow trees={MID_TREES} fill="#0c2a20" trunk="#0a2119" />

      {/* 手前の幹（左右のフレーミング。少しだけ明暗を付けて円柱に見せる） */}
      <g>
        <path d="M6 0 h74 q-12 156 -6 312 q6 166 12 308 h-86 q10 -170 12 -334 q4 -146 -6 -286 Z" fill="#071711" />
        <path d="M56 0 h24 q-10 156 -5 312 q5 166 11 308 h-26 q-6 -160 -10 -316 q-4 -150 6 -304 Z" fill="#0d251b" />
        <path d="M60 186 q52 -20 92 -62 q-26 60 -88 88 Z" fill="#071711" />
        <path d="M1120 0 h74 q-12 160 -6 320 q6 160 12 300 h-86 q10 -166 12 -326 q4 -148 -6 -294 Z" fill="#071711" />
        <path d="M1120 0 h22 q-9 160 -4 320 q5 160 10 300 h-24 q-6 -160 -10 -318 q-4 -148 6 -302 Z" fill="#0d251b" />
        <path d="M1116 226 q-56 -18 -100 -58 q32 60 96 84 Z" fill="#071711" />
      </g>

      {/* 霧（うっすら一段だけ） */}
      <rect x="0" y="316" width="1200" height="116" fill="url(#gdf-fog)" />

      {/* 地面（円になって座っている「ひらけた場所」） */}
      <path d="M0 410 Q300 372 600 378 Q900 372 1200 410 L1200 620 L0 620 Z" fill="url(#gdf-ground)" />
      <ellipse cx="600" cy="498" rx="486" ry="132" fill="url(#gdf-clearing)" />
      {/* 下草（地面の質感を最小限に） */}
      <g fill="#3a6244" opacity="0.55">
        <path d="M96 436 q11 -24 22 0 z" />
        <path d="M256 422 q13 -28 26 0 z" />
        <path d="M944 424 q13 -28 26 0 z" />
        <path d="M1092 438 q11 -24 22 0 z" />
      </g>
    </svg>
  );
}
