// PASSAI 就活版 — GD「Forest Circle」の参加者アバター（椅子に座った stylized 3D フィギュア）。
//
// 方針:
//   - 画像素材・3D エンジンを使わない。SVG のパスと共有シェーディング（ForestBackdrop の
//     <defs>）だけで「立体物」に見せる。**静止画的で軽量**（キャラクターに動作は付けない）。
//   - 3D に見せる作り方:
//       ① 椅子を透視で描く（座面は奥が狭く手前が広い四角形／前脚は太く後脚は細い）
//       ② 面ごとに明度を変える（上面は明るく、前面は中間、側面は暗い）
//       ③ 体・頭は基本色のベタ塗りの上に球/円柱/平面の陰影を重ねる（url(#gdfSphere) 等）
//       ④ 接地影・座面への落ち影・首下のオクルージョンで「置かれている」ことを示す
//       ⑤ 光源は上手前やや左に固定。左側にリムライト、右側に影。
//   - 見た目の差分は participantId から決定的に決める（SSR/CSR で同じ DOM）。
//   - 性別を強調しない。体型・顔の作りは全員共通で、髪型と配色だけを分散させる。
//   - 発話状態は data-speech（親 seat）で CSS が演出する。色だけに依存せず、
//     ドット・名前札のテキストでも「発言中 / 考え中」を示す。

import type { GdSeat } from './seatLayout';
import type { GdStageParticipant, GdStageSeatTestHook } from './types';
import { GD_CONNECTION_LABELS } from '@/lib/careerGd/presence';

type Palette = {
  skin: string;
  skinShade: string;
  hair: string;
  hairLit: string;
  cloth: string;
  clothDark: string;
  trousers: string;
  trousersDark: string;
  shoe: string;
};

const SKINS: [string, string][] = [
  ['#f3d0af', '#dcb18d'],
  ['#e4b189', '#c9946e'],
  ['#c98f68', '#ab7551'],
  ['#a5714f', '#8a5b3d'],
];
const HAIRS: [string, string][] = [
  ['#2b2320', '#4a3d36'],
  ['#3d2c22', '#5c463a'],
  ['#1d1a19', '#37312e'],
  ['#4b3a2b', '#6b563f'],
  ['#5c4735', '#7d6349'],
];
// 人間参加者の服（暖色寄り）／AI 参加者の服（寒色寄り）。色は識別の補助でしかなく、
// AI かどうかは名前札の「AI」バッジ（テキスト）で判別できるようにしている。
const HUMAN_CLOTH: [string, string][] = [
  ['#c86f4e', '#9d5238'],
  ['#4f7fa8', '#3a5f80'],
  ['#b5893c', '#8b672a'],
  ['#5c8f69', '#446a4e'],
  ['#8a6ea8', '#67507f'],
  ['#bf6a86', '#934c64'],
];
const AI_CLOTH: [string, string][] = [
  ['#3f8079', '#2d5f5a'],
  ['#4a6f92', '#35526e'],
  ['#6a7f9c', '#4c5d75'],
  ['#4d7f66', '#375f4b'],
];
const TROUSERS: [string, string][] = [
  ['#3a4658', '#2a3341'],
  ['#4a4238', '#352f28'],
  ['#33454a', '#243135'],
  ['#443a4d', '#302939'],
];

// 木部（椅子）。上面 / 前面 / 側面で明度を変えて面の向きを表す。
const WOOD = {
  top: '#96683d',
  front: '#7a5330',
  side: '#5d3e22',
  dark: '#4a3019',
  lit: '#b08050',
};

function hashSeed(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function paletteFor(seed: number, isAi: boolean): Palette {
  const [skin, skinShade] = SKINS[seed % SKINS.length];
  const [hair, hairLit] = HAIRS[Math.floor(seed / 3) % HAIRS.length];
  const [cloth, clothDark] = isAi
    ? AI_CLOTH[Math.floor(seed / 7) % AI_CLOTH.length]
    : HUMAN_CLOTH[Math.floor(seed / 7) % HUMAN_CLOTH.length];
  const [trousers, trousersDark] = TROUSERS[Math.floor(seed / 11) % TROUSERS.length];
  return { skin, skinShade, hair, hairLit, cloth, clothDark, trousers, trousersDark, shoe: '#26262a' };
}

// 胴（肩→腰）。ベタ塗りと陰影オーバーレイで 3 回使うので定数にする。
//   肩 y=62 / 腰 y=108。椅子の座面より上で終わり、腰から先（太もも）は座面の手前に描く。
const TORSO =
  'M64 60 C53 60 47.5 66.5 46.5 76 L44 100 C43.2 105.5 46.4 109 51 109 L77 109 C81.6 109 84.8 105.5 84 100 L81.5 76 C80.5 66.5 75 60 64 60 Z';

/** 椅子に座った人物（stylized 3D・静止）。
 *  重なり順が「座っている」の説得力を作る:
 *    接地影 → 後脚 → 背もたれ → 座面（椅子を完成させる）→ 胴・腕・頭
 *    → 太もも（座面の手前）→ 脛・靴 → 手（膝の上）
 */
function SeatedFigure({ palette, hairStyle }: { palette: Palette; hairStyle: 0 | 1 | 2 }) {
  return (
    <svg className="gdf-figure" viewBox="0 0 128 160" aria-hidden="true" focusable="false">
      {/* 接地影（床に置かれていることを示す） */}
      <ellipse cx="64" cy="150" rx="40" ry="8" fill="url(#gdfContact)" />

      {/* 椅子：後脚（すべての奥） */}
      <g fill={WOOD.dark}>
        <path d="M44 104 L49 104 L46.5 132 L42 132 Z" />
        <path d="M79 104 L84 104 L86 132 L81.5 132 Z" />
      </g>

      {/* 椅子：背もたれ（側面 → 前面 → 上端ハイライト） */}
      <g>
        <path d="M40 40 L35 45.5 L37 106 L43 102 Z" fill={WOOD.side} />
        <path d="M40 40 L88 42.5 L90 104 L43 102 Z" fill={WOOD.front} />
        <path d="M40 40 L88 42.5 L90 104 L43 102 Z" fill="url(#gdfSide)" />
        <path d="M40 40 L88 42.5 L88.4 48.5 L40.2 46 Z" fill={WOOD.lit} opacity="0.85" />
        <path d="M62.5 46 L66.5 46.2 L67.5 103 L63.5 103 Z" fill={WOOD.side} opacity="0.45" />
      </g>

      {/* 椅子：座面（奥が狭く手前が広い透視四角）＋ 前面 ＋ 前脚 */}
      <g>
        <path d="M36 103 L92 105 L102 116 L26 114 Z" fill={WOOD.top} />
        <path d="M36 103 L92 105 L102 116 L26 114 Z" fill="url(#gdfVert)" opacity="0.65" />
        <path d="M26 114 L102 116 L100.5 123 L27.5 121 Z" fill={WOOD.front} />
        <path d="M26 114 L102 116 L102 117.5 L26 115.5 Z" fill={WOOD.lit} opacity="0.7" />
        <path d="M28.5 121 L37 121.5 L35 145 L26.5 144.5 Z" fill={WOOD.front} />
        <path d="M28.5 121 L31.3 121.2 L29.6 144.7 L26.5 144.5 Z" fill={WOOD.lit} opacity="0.5" />
        <path d="M91.5 122 L100 122.5 L102 145.5 L93.5 145 Z" fill={WOOD.side} />
      </g>

      {/* 人物：首 → 胴 → 腕 → 頭 */}
      <g>
        <path d="M57 48 L71 48 L71 61 Q64 65.5 57 61 Z" fill={palette.skinShade} />
        <ellipse cx="64" cy="55" rx="8" ry="3.2" fill="#00160f" opacity="0.3" />
        {/* 体が座面に落とす影（腰まわり） */}
        <ellipse cx="64" cy="106" rx="24" ry="6.5" fill="#00140d" opacity="0.26" />
        <path d={TORSO} fill={palette.cloth} />
        <path d={TORSO} fill="url(#gdfVert)" />
        <path d={TORSO} fill="url(#gdfSide)" />
        {/* 肩の面（低ポリ的な面の切り替わり） */}
        <path d="M52 68 Q64 61 76 68 L74.5 74 Q64 68 53.5 74 Z" fill="#ffffff" opacity="0.11" />
        {/* 腕（胴の外側に出す。左は光側で明るく、右は影側で暗い） */}
        <path
          d="M48 69 L41.5 91 L52 105"
          fill="none"
          stroke={palette.cloth}
          strokeWidth="12"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M48 69 L41.5 91 L52 105"
          fill="none"
          stroke="#ffffff"
          strokeOpacity="0.14"
          strokeWidth="4.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M80 69 L86.5 91 L76 105"
          fill="none"
          stroke={palette.clothDark}
          strokeWidth="12"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* 腕と胴のあいだの影（シルエットを分離して立体に見せる） */}
        <path
          d="M52 70 L47 90"
          fill="none"
          stroke="#00160f"
          strokeOpacity="0.22"
          strokeWidth="3"
          strokeLinecap="round"
        />
        <path
          d="M76 70 L81 90"
          fill="none"
          stroke="#00160f"
          strokeOpacity="0.28"
          strokeWidth="3"
          strokeLinecap="round"
        />
        {/* 頭（球の陰影＋左側のリムライト） */}
        <ellipse cx="49.5" cy="40" rx="3.4" ry="4.4" fill={palette.skinShade} />
        <circle cx="64" cy="38" r="15.5" fill={palette.skin} />
        <circle cx="64" cy="38" r="15.5" fill="url(#gdfSphere)" />
        <path
          d="M51 31 A15.5 15.5 0 0 0 51.8 47"
          fill="none"
          stroke="#fff5e6"
          strokeOpacity="0.3"
          strokeWidth="2.2"
          strokeLinecap="round"
        />
        {/* 髪（頭の丸みに沿った殻＋つや） */}
        {hairStyle === 1 && (
          <g fill={palette.hair}>
            <path d="M48.5 33 q-2.6 13 1 20 q4.6 2.8 7.4 -1 q-3.7 -8 -2.8 -18 z" />
            <path d="M79.5 33 q2.6 13 -1 20 q-4.6 2.8 -7.4 -1 q3.7 -8 2.8 -18 z" />
          </g>
        )}
        {hairStyle === 2 && (
          <g>
            <circle cx="64" cy="19.5" r="6.4" fill={palette.hair} />
            <circle cx="61.8" cy="17.8" r="2.4" fill={palette.hairLit} opacity="0.6" />
          </g>
        )}
        <path d="M48.5 38 A15.5 15.5 0 0 1 79.5 38 L73.6 38 A12 12 0 0 0 52.8 32.5 Z" fill={palette.hair} />
        <path
          d="M54 27.5 Q64 22 74 27"
          fill="none"
          stroke={palette.hairLit}
          strokeWidth="2.8"
          strokeLinecap="round"
          opacity="0.75"
        />
        {/* 目（造形は最小限。3/4 に見えるようわずかに左へ寄せる） */}
        <g fill="#20302c" opacity="0.86">
          <ellipse cx="58" cy="40" rx="1.8" ry="2" />
          <ellipse cx="69.5" cy="40" rx="1.7" ry="1.9" />
        </g>
      </g>

      {/* 太もも（座面の手前へ張り出す）→ 脛 → 靴 */}
      <g>
        <rect x="47" y="99" width="17" height="22" rx="8" fill={palette.trousers} />
        <rect x="47" y="99" width="17" height="22" rx="8" fill="url(#gdfVert)" />
        <rect x="64" y="99" width="17" height="22" rx="8" fill={palette.trousersDark} />
        <rect x="64" y="99" width="17" height="22" rx="8" fill="url(#gdfVert)" />
        <rect x="49.5" y="100.5" width="12" height="4.5" rx="2.2" fill="#ffffff" opacity="0.12" />
        <rect x="49" y="115" width="14" height="28" rx="6.5" fill={palette.trousers} />
        <rect x="49" y="115" width="14" height="28" rx="6.5" fill="url(#gdfSide)" />
        <rect x="65" y="115" width="14" height="28" rx="6.5" fill={palette.trousersDark} />
        <rect x="65" y="115" width="14" height="28" rx="6.5" fill="url(#gdfSide)" />
        <ellipse cx="55" cy="144.5" rx="9.5" ry="5.2" fill={palette.shoe} />
        <ellipse cx="53.4" cy="143" rx="5.2" ry="2.1" fill="#ffffff" opacity="0.14" />
        <ellipse cx="73" cy="144.5" rx="9.5" ry="5.2" fill="#1c1c1f" />
      </g>

      {/* 手（膝の上） */}
      <g>
        <circle cx="53" cy="105.5" r="4.8" fill={palette.skin} />
        <circle cx="53" cy="105.5" r="4.8" fill="url(#gdfSphere)" />
        <circle cx="75" cy="105.5" r="4.8" fill={palette.skinShade} />
        <circle cx="75" cy="105.5" r="4.8" fill="url(#gdfSphere)" />
      </g>
    </svg>
  );
}

export function ParticipantAvatar({
  participant,
  seat,
  sizeFactor,
  testHook,
}: {
  participant: GdStageParticipant;
  seat: GdSeat;
  sizeFactor: number;
  testHook?: GdStageSeatTestHook;
}) {
  const seed = hashSeed(participant.participantId || participant.key);
  const palette = paletteFor(seed, participant.isAi);
  const hairStyle = (seed % 3) as 0 | 1 | 2;
  const speech = participant.speech;
  const connection = participant.connection ?? null;

  return (
    <div
      className="gdf-seat"
      data-speech={speech}
      data-self={String(participant.isSelf)}
      {...(testHook?.testId ? { 'data-testid': testHook.testId } : {})}
      {...(testHook?.attrs ?? {})}
      style={
        {
          '--gdf-x': seat.x,
          '--gdf-y': seat.y,
          // 奥行き（0 = 最奥 / 1 = 最前）。空気遠近（彩度・明度）を CSS 側で当てる。
          '--gdf-depth': seat.depth,
          '--gdf-sc': Number((seat.scale * sizeFactor).toFixed(4)),
          zIndex: seat.zIndex,
        } as React.CSSProperties
      }
    >
      <div className={`gdf-seat__figure${participant.left ? ' gdf-seat__figure--left' : ''}`}>
        {/* 会話中インジケータ（頭上の「・・・」）。文章は表示しない。 */}
        {speech !== 'idle' && (
          <span className="gdf-seat__bubble" data-speech={speech} aria-hidden="true">
            <span className="gdf-seat__dot" />
            <span className="gdf-seat__dot" />
            <span className="gdf-seat__dot" />
          </span>
        )}
        <span className="gdf-seat__ring" aria-hidden="true" />
        <SeatedFigure palette={palette} hairStyle={hairStyle} />
      </div>

      <div className="gdf-seat__plate">
        <span className="gdf-seat__name">
          {connection && !participant.isAi && (
            <span
              className="gdf-seat__presence"
              data-testid="gd-presence-dot"
              data-online={String(connection === 'online')}
              data-state={connection}
              aria-label={GD_CONNECTION_LABELS[connection]}
              title={GD_CONNECTION_LABELS[connection]}
            />
          )}
          <span className="gdf-seat__nameText">{participant.displayName}</span>
        </span>
        <span className="gdf-seat__meta">
          {participant.isSelf && <span className="gdf-seat__tag gdf-seat__tag--self">あなた</span>}
          {participant.isAi && <span className="gdf-seat__tag gdf-seat__tag--ai">AI</span>}
          {participant.isHost && <span className="gdf-seat__tag">ホスト</span>}
          {participant.left && <span className="gdf-seat__tag">退出</span>}
          <span className="gdf-seat__role">{participant.personaRole || participant.roleLabel}</span>
        </span>
        {speech !== 'idle' && (
          <span className="gdf-seat__state" data-speech={speech}>
            {speech === 'speaking' ? '発言中' : '考え中'}
          </span>
        )}
      </div>
    </div>
  );
}
