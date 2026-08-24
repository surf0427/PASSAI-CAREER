// PASSAI 就活版 — GD「Forest Circle」の参加者アバター（椅子に座った簡易 2D 人物）。
//
// 方針:
//   - 画像素材を持たない。すべて SVG パスで描く（PASSAI オリジナル）。
//   - 「椅子に座っている」ことが構図で分かるよう、背もたれ → 人物 → 座面 → 脛 の順に重ねる。
//   - 見た目の差分は participantId から決定的に決める（SSR/CSR で同じ DOM になる）。
//   - 性別を強調しない。体型・顔は全員共通で、髪型と配色だけを分散させる。
//   - 発話状態は data-speech（親 seat）で CSS が演出する。色だけに依存せず、
//     ドット・名前札のテキストでも「発言中 / 考え中」を示す。

import type { GdSeat } from './seatLayout';
import type { GdStageParticipant, GdStageSeatTestHook } from './types';
import { GD_CONNECTION_LABELS } from '@/lib/careerGd/presence';

type Palette = {
  skin: string;
  skinShade: string;
  hair: string;
  cloth: string;
  clothDark: string;
  trousers: string;
  shoe: string;
};

const SKINS: [string, string][] = [
  ['#f2cdab', '#e0b892'],
  ['#e3b088', '#cf9c76'],
  ['#c98f68', '#b57c58'],
  ['#a5714f', '#8f6042'],
];
const HAIRS = ['#2b2320', '#3d2c22', '#1d1a19', '#4b3a2b', '#5c4735'];
// 人間参加者の服（暖色寄り）／AI 参加者の服（寒色寄り）。色は識別の補助でしかなく、
// AI かどうかは名前札の「AI」バッジ（テキスト）で判別できるようにしている。
const HUMAN_CLOTH: [string, string][] = [
  ['#c86f4e', '#a95a3d'],
  ['#4f7fa8', '#3e688c'],
  ['#b5893c', '#96702f'],
  ['#5c8f69', '#487454'],
  ['#8a6ea8', '#71578d'],
  ['#bf6a86', '#a1556e'],
];
const AI_CLOTH: [string, string][] = [
  ['#3f8079', '#316660'],
  ['#4a6f92', '#3a5876'],
  ['#6a7f9c', '#546780'],
  ['#4d7f66', '#3c6650'],
];
const TROUSERS = ['#3a4658', '#4a4238', '#33454a', '#443a4d'];
const WOOD = '#78522f';
const WOOD_DARK = '#5b3d22';

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
  const [cloth, clothDark] = isAi
    ? AI_CLOTH[Math.floor(seed / 7) % AI_CLOTH.length]
    : HUMAN_CLOTH[Math.floor(seed / 7) % HUMAN_CLOTH.length];
  return {
    skin,
    skinShade,
    hair: HAIRS[Math.floor(seed / 3) % HAIRS.length],
    cloth,
    clothDark,
    trousers: TROUSERS[Math.floor(seed / 11) % TROUSERS.length],
    shoe: '#2b2a2c',
  };
}

/** 椅子に座った人物（正面・簡易 2D）。 */
function SeatedFigure({ palette, hairStyle }: { palette: Palette; hairStyle: 0 | 1 | 2 }) {
  return (
    <svg className="gdf-figure" viewBox="0 0 120 152" aria-hidden="true" focusable="false">
      {/* 足元の影（地面に接地して見せる） */}
      <ellipse cx="60" cy="143" rx="33" ry="6.4" fill="#07130f" opacity="0.42" />

      {/* 椅子：背もたれ（人物の後ろ） */}
      <g>
        <rect x="33" y="43" width="54" height="9" rx="4.5" fill={WOOD} />
        <rect x="35" y="49" width="7" height="54" rx="3.5" fill={WOOD_DARK} />
        <rect x="78" y="49" width="7" height="54" rx="3.5" fill={WOOD_DARK} />
        <rect x="35" y="63" width="50" height="7" rx="3.5" fill={WOOD} />
      </g>

      {/* 人物：首 → 胴 → 腕 → 頭 */}
      <rect x="53.5" y="46" width="13" height="14" rx="6" fill={palette.skinShade} />
      <path
        d="M60 58 C47 58 39 65 37.5 76 L34 100 C33.2 105 36.5 108 41 108 L79 108 C83.5 108 86.8 105 86 100 L82.5 76 C81 65 73 58 60 58 Z"
        fill={palette.cloth}
      />
      <path
        d="M40 78 L34 96 L46 106"
        fill="none"
        stroke={palette.clothDark}
        strokeWidth="12"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M80 78 L86 96 L74 106"
        fill="none"
        stroke={palette.clothDark}
        strokeWidth="12"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="46" cy="106" r="5.4" fill={palette.skin} />
      <circle cx="74" cy="106" r="5.4" fill={palette.skin} />
      <circle cx="60" cy="36" r="15.5" fill={palette.skin} />
      {hairStyle === 1 && (
        <g fill={palette.hair}>
          <rect x="43.5" y="30" width="8" height="22" rx="4" />
          <rect x="68.5" y="30" width="8" height="22" rx="4" />
        </g>
      )}
      {hairStyle === 2 && <circle cx="60" cy="18.5" r="6.5" fill={palette.hair} />}
      <path d="M44.5 36 A15.5 15.5 0 0 1 75.5 36 L70 36 A12 12 0 0 0 50 36 Z" fill={palette.hair} />
      <g fill="#1f2b28" opacity="0.82">
        <circle cx="54" cy="37.5" r="1.8" />
        <circle cx="66" cy="37.5" r="1.8" />
      </g>

      {/* 椅子：座面（人物の手前に重ねることで「座っている」ことが分かる） */}
      <rect x="24" y="98" width="72" height="11" rx="5" fill={WOOD} />
      <rect x="24" y="105" width="72" height="4" rx="2" fill={WOOD_DARK} opacity="0.85" />
      {/* 椅子：前脚 */}
      <rect x="28" y="108" width="7" height="30" rx="3.5" fill={WOOD_DARK} />
      <rect x="85" y="108" width="7" height="30" rx="3.5" fill={WOOD_DARK} />

      {/* 太もも → 脛 → 靴（座面の手前） */}
      <rect x="40" y="92" width="40" height="16" rx="8" fill={palette.trousers} />
      <path d="M50 104 L48 130" stroke={palette.trousers} strokeWidth="13" strokeLinecap="round" fill="none" />
      <path d="M70 104 L72 130" stroke={palette.trousers} strokeWidth="13" strokeLinecap="round" fill="none" />
      <ellipse cx="47" cy="134" rx="9.5" ry="5.5" fill={palette.shoe} />
      <ellipse cx="73" cy="134" rx="9.5" ry="5.5" fill={palette.shoe} />
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
