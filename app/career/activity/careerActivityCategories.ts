// 就活版「活動整理」(/career/activity) の選択肢・候補・レベル定数。
//
// 型（@/types/careerActivity）から参照される列挙値の正本。保存層の正規化
// （activityStorage.normalizeCareerActivity）でも妥当値の検証に使う。

import type { ItSkillLevel, LanguageLevel } from '@/types/careerActivity';

// ⑪ IT スキルのレベル（未入力 '' を除いた選択肢）。
export const IT_SKILL_LEVELS = ['未経験', '初級', '中級', '上級'] as const satisfies readonly Exclude<ItSkillLevel, ''>[];

// ⑪ IT スキル名の入力候補（datalist 用。自由入力も許可）。
export const IT_SKILL_SUGGESTIONS = [
  'Excel',
  'Word',
  'PowerPoint',
  'Google Workspace',
  'Python',
  'Java',
  'JavaScript',
  'HTML/CSS',
  'SQL',
  'Git',
  'Figma',
  'Photoshop',
  'Illustrator',
  'Canva',
  'Notion',
  'ChatGPT',
  'Claude',
  'Gemini',
] as const;

// ⑫ 語学のレベル（CEFR + ネイティブ。未入力 '' を除く）。
export const LANGUAGE_LEVELS = [
  'ネイティブ',
  'C2',
  'C1',
  'B2',
  'B1',
  'A2',
  'A1',
] as const satisfies readonly Exclude<LanguageLevel, ''>[];

// ⑫ 言語の入力候補（datalist 用。自由入力も許可）。
export const LANGUAGE_SUGGESTIONS = [
  '英語',
  '中国語',
  '韓国語',
  'イタリア語',
  'ドイツ語',
  'フランス語',
] as const;

// ① MBTI の入力候補（datalist 用。自由入力・未診断も許可）。
export const MBTI_TYPES = [
  'INTJ',
  'INTP',
  'ENTJ',
  'ENTP',
  'INFJ',
  'INFP',
  'ENFJ',
  'ENFP',
  'ISTJ',
  'ISFJ',
  'ESTJ',
  'ESFJ',
  'ISTP',
  'ISFP',
  'ESTP',
  'ESFP',
] as const;

// ⑥ プロジェクト経験の例（プレースホルダ/補足表示用）。
export const PROJECT_EXAMPLES =
  '個人開発・アプリ開発・起業・ハッカソン・イベント運営・学内プロジェクト・チーム開発 など';

// ⑮ SNS・情報発信の例。
export const SNS_EXAMPLES = 'YouTube・TikTok・Instagram・X・note・ブログ など';

// ⑮ プラットフォームの入力候補（datalist 用。自由入力も許可）。
export const SNS_PLATFORM_SUGGESTIONS = [
  'YouTube',
  'TikTok',
  'Instagram',
  'X',
  'note',
  'ブログ',
  'LinkedIn',
] as const;

// ⑯ ポートフォリオ・制作物の例。
export const PORTFOLIO_EXAMPLES =
  'GitHub・ポートフォリオサイト・Qiita・Zenn・Behance・Dribbble など';

// ⑯ 制作物の種類の入力候補（datalist 用。自由入力も許可）。
export const PORTFOLIO_KIND_SUGGESTIONS = [
  'GitHub',
  'Webサイト',
  'アプリ',
  'Qiita',
  'Zenn',
  'Behance',
  'Dribbble',
  'Figma',
  'デザイン作品',
  '動画作品',
] as const;

export const IS_VALID_IT_SKILL_LEVEL = new Set<string>(IT_SKILL_LEVELS);
export const IS_VALID_LANGUAGE_LEVEL = new Set<string>(LANGUAGE_LEVELS);
