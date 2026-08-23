// 事業者情報・連絡先の集約。特定商取引法に基づく表記 / プライバシーポリシーの
// 問い合わせ窓口 / お問い合わせページ / 運営者情報ページは、表記の二重管理を避ける
// ため本ファイルを single source として import する。
//
// 価格・サービス内容（法定表示）は lib/careerPricing.ts を正とし、ここでは
// 表示用の文言を組み立て直さない（金額そのものを再定義しない）。
//
// ★ この deployment が販売しているのは PASSAI CAREER（新卒就活向け）のみ。
//   受験版 catalog（lib/billing/plans.ts の PLANS / priceJpy）を法定表示へ
//   参照しないこと。以前ここが受験版の Basic ¥2,980 / Premium ¥4,980 を
//   販売価格として表示しており、実際に売っている商品と食い違っていた。

import {
  CAREER_PUBLIC_SALES_PRICE_LABEL,
  CAREER_PUBLIC_SERVICE_DESCRIPTION,
} from '@/lib/careerPricing';

export const BUSINESS_NAME = 'PASSAI';
export const OPERATOR_NAME = '窪田 慶大';
export const CONTACT_EMAIL = 'passai.jp@gmail.com';

// ★ 特定商取引法に基づく表記（/legal/commerce）の「サービス内容」欄。
//   直下に SALES_PRICE_LABEL が並ぶ＝**有料で販売している役務**の法定表示であるため、
//   現在課金対象になっているサービス（PASSAI CAREER）の内容と必ず一致させること。
export const SERVICE_DESCRIPTION = CAREER_PUBLIC_SERVICE_DESCRIPTION;

// 運営者情報（/about）の「サービス内容」欄。
//   SERVICE_DESCRIPTION とは用途が異なる（法定表示ではなく、事業者が公開・提供して
//   いるサービスの案内）ため、販売の有無にかかわらず製品ラインを併記できる。
//   価格・契約条件には一切言及しない。
export const OPERATOR_SERVICES_DESCRIPTION =
  '大学受験向けの「PASSAI」および新卒就活向けの「PASSAI CAREER」の提供';

// 所在地・電話番号は特定商取引法に基づき、請求時に遅滞なく開示する運用とする。
export const DISCLOSURE_ON_REQUEST = '請求があった際に遅滞なく開示いたします。';

// 特商法ページ「販売価格」欄に表示する 1 行表記（単一プラン）。
export const SALES_PRICE_LABEL = CAREER_PUBLIC_SALES_PRICE_LABEL;
