// 事業者情報・連絡先の集約。特定商取引法に基づく表記 / プライバシーポリシーの
// 問い合わせ窓口 / お問い合わせページ / 運営者情報ページは、表記の二重管理を避ける
// ため本ファイルを single source として import する。
//
// 価格は lib/billing/plans.ts の priceJpy を正とし、ここでは表示用の文言だけを
// 組み立てる（金額そのものを再定義しない）。

import { PLANS } from '@/lib/billing/plans';

export const BUSINESS_NAME = 'PASSAI';
export const OPERATOR_NAME = '窪田 慶大';
export const CONTACT_EMAIL = 'passai.jp@gmail.com';
// ★ 特定商取引法に基づく表記（/legal/commerce）の「サービス内容」欄。
//   直下に SALES_PRICE_LABEL（Basic / Premium）が並ぶ＝**有料で販売している役務**の
//   法定表示であるため、現在課金対象になっているサービスの内容から動かさないこと。
//   PASSAI CAREER は決済導線が無く販売対象ではないため、ここには含めない。
export const SERVICE_DESCRIPTION = '総合型選抜・推薦入試対策AIサービス';

// 運営者情報（/about）の「サービス内容」欄。
//   SERVICE_DESCRIPTION とは用途が異なる（法定表示ではなく、事業者が公開・提供して
//   いるサービスの案内）ため、販売の有無にかかわらず製品ラインを併記できる。
//   価格・契約条件には一切言及しない。
export const OPERATOR_SERVICES_DESCRIPTION =
  '大学受験向けの「PASSAI」および新卒就活向けの「PASSAI CAREER」の提供';

// 所在地・電話番号は特定商取引法に基づき、請求時に遅滞なく開示する運用とする。
export const DISCLOSURE_ON_REQUEST = '請求があった際に遅滞なく開示いたします。';

const formatJpy = (amount: number) => `${amount.toLocaleString('ja-JP')}円`;

// 各プランの「<ラベル> 月額<金額>（税込）」表記。金額は plans.ts の priceJpy 由来。
export const PLAN_PRICE_LABELS: Record<keyof typeof PLANS, string> = {
  basic: `${PLANS.basic.label} 月額${formatJpy(PLANS.basic.priceJpy)}（税込）`,
  premium: `${PLANS.premium.label} 月額${formatJpy(PLANS.premium.priceJpy)}（税込）`,
};

// 特商法ページ「販売価格」欄に表示する 1 行表記。
export const SALES_PRICE_LABEL = `${PLAN_PRICE_LABELS.basic} / ${PLAN_PRICE_LABELS.premium}`;
