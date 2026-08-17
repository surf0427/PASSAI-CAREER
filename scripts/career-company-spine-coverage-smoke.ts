/*
 * scripts/career-company-spine-coverage-smoke.ts
 *
 * PASSAI CAREER — Company Data Spine の **項目カバレッジ smoke test**。
 *
 * 何を測るか:
 *   企業のタイプ（大手上場 / tech ベンチャー / 情報量の少ない中小）ごとに、
 *   公式サイトの実際の情報量から **何項目取れて、何項目が正常に欠損するか**。
 *   目的は「取れない企業でも壊れない（partial 耐性）」ことの確認であり、
 *   満点を取ることではない。
 *
 * ★ 何が本物で、何が fake か（結果の読み方）
 *   本物: HTML → text/link/JSON-LD 抽出、official domain 検証、入口ページ検出、
 *         **出典 grounding 検証**、fact mapping、merge、projection、prompt renderer。
 *   fake: ネットワーク（fixture HTML）、DB、LLM 抽出。
 *   LLM は「そのページに実際に書かれている値を返す oracle ＋ 各ページ 1 件の幻覚」に
 *   置き換えている。したがって本 smoke が測るのは **pipeline のカバレッジと
 *   幻覚除去**であり、LLM の抽出精度そのものではない。
 *
 * 実ネットワークでの smoke には次が必要（本環境では未設定なので実行できない）:
 *   CAREER_COMPANY_SEARCH_ENDPOINT / CAREER_COMPANY_SEARCH_API_KEY（公式サイト探索）
 *   CAREER_CORPORATE_REGISTRY_APP_ID（法人番号 → identity group）
 *   CAREER_COMPANY_PREFETCH_ENABLED / ..._EXTERNAL_FETCH_ENABLED = true
 *   supabase/career_company_official_facts_apply.sql の適用（永続化）
 *
 * 使い方: npx tsx --tsconfig tsconfig.realtime-test.json scripts/career-company-spine-coverage-smoke.ts
 */

import {
  COMPANY_FACT_KEYS,
  COMPANY_FACT_KEY_GROUP,
  OPPORTUNISTIC_FACT_GROUPS,
  PREFETCH_FACT_GROUPS,
  type CompanyFactGroup,
  type CompanyFactGroupState,
  type CompanyFactKey,
} from '@/types/careerCompanyOfficial';
import { buildCompanyOfficialContext, type FactRow } from '@/lib/careerCompanyOfficial/projection';
import { COMPANY_FACT_SCHEMA_REVISION } from '@/lib/careerCompanyPrefetch/constants';
import { buildCompanyEnrichmentIdentity } from '@/lib/careerCompanyPrefetch/idempotency';
import {
  DEVELOPMENTS_SPEC,
  IR_SPEC,
  PHILOSOPHY_SPEC,
  RECRUITING_SPEC,
  normalizeBySpec,
  normalizeExtractedProfile,
  type ExtractedCompanyDevelopments,
  type ExtractedCompanyIr,
  type ExtractedCompanyPhilosophy,
  type ExtractedCompanyRecruiting,
} from '@/lib/careerCompanyPrefetch/extraction';
import { extractJsonLdOrganization, extractLinks, extractTitle, htmlToText } from '@/lib/careerCompanyPrefetch/htmlText';
import {
  runCompanyPrefetch,
  type PrefetchDeps,
  type SiteDocument,
} from '@/lib/careerCompanyPrefetch/prefetchJobService';
import { renderCompanyOfficialForPurpose } from '@/lib/careerContextRenderers/companyOfficialContext';
import type { ProviderSourceRef, RegistryCompanyCandidate } from '@/lib/careerCompanyPrefetch/providers/types';

const NOW = '2026-08-17T12:00:00.000Z';

// ════════════════════════════════════════════════════════════════════
// fixture（実在企業ではなく、企業タイプごとの **情報量の型**を再現した架空サイト）
// ════════════════════════════════════════════════════════════════════
type Fixture = {
  label: string;
  note: string;
  host: string;
  origin: string;
  /** 公的 registry で裏が取れるか（国内法人 + registry 設定済みを想定するか）。 */
  registry: RegistryCompanyCandidate | null;
  displayName: string;
  /** URL → HTML。存在しない URL は 404 として扱う。 */
  pages: Readonly<Record<string, string>>;
  /**
   * ページ別 LLM 抽出の oracle（そのページに実際に書かれている値）。
   * `hallucination` は本文に無い値。grounding 検証で落ちることを確認するために混ぜる。
   */
  oracle: {
    profile?: Record<string, unknown>;
    philosophy?: Record<string, unknown>;
    ir?: Record<string, unknown>;
    recruiting?: Record<string, unknown>;
    developments?: Record<string, unknown>;
  };
  /**
   * この fixture の oracle に仕込んだ「本文に無い値」（fact key と値）。
   * grounding 検証が本当に効いていれば、これらは 1 つも保存されない。
   */
  planted: readonly [CompanyFactKey, string][];
};

const nav = (origin: string, items: readonly [string, string][]) =>
  items.map(([href, label]) => `<a href="${origin}${href}">${label}</a>`).join('\n');

// ── A: 大手上場メーカー（会社概要・理念・IR・採用・ニュースが全部ある）──────
const LARGE: Fixture = {
  label: 'A 大手上場メーカー（情報量: 多）',
  note: '会社概要 / 理念 / 決算 / 採用 / ニュースをすべて公開',
  host: 'www.daiwa-denki.co.jp',
  origin: 'https://www.daiwa-denki.co.jp',
  displayName: '大和電機株式会社',
  registry: {
    corporateNumber: '1234567890123',
    legalName: '大和電機株式会社',
    legalNameKana: 'ダイワデンキ',
    legalNameEn: 'Daiwa Denki Corporation',
    prefecture: '東京都',
    address: '東京都港区芝浦3-1-1',
    registrationStatus: '存続',
    formerNames: ['大和電機工業株式会社'],
  },
  pages: {
    'https://www.daiwa-denki.co.jp/': `<html><head><title>大和電機株式会社</title>
      <script type="application/ld+json">{"@type":"Organization","name":"大和電機株式会社","url":"https://www.daiwa-denki.co.jp/"}</script>
      </head><body><h1>大和電機株式会社</h1>
      ${nav('https://www.daiwa-denki.co.jp', [
        ['/company/', '会社概要'],
        ['/philosophy/', '経営理念'],
        ['/ir/library/', '決算情報'],
        ['/recruit/', '採用情報'],
        ['/news/', 'ニュースリリース'],
        ['/ir/', 'IR情報'],
      ])}</body></html>`,
    'https://www.daiwa-denki.co.jp/company/': `<html><head><title>会社概要 | 大和電機株式会社</title></head><body>
      <table>
      <tr><th>商号</th><td>大和電機株式会社</td></tr>
      <tr><th>代表者</th><td>代表取締役社長　佐藤 健一</td></tr>
      <tr><th>設　立</th><td>1949年6月20日</td></tr>
      <tr><th>創　業</th><td>1932年4月</td></tr>
      <tr><th>資本金</th><td>1,204億円（2026年3月31日現在）</td></tr>
      <tr><th>従業員数</th><td>28,450名（連結・2026年3月31日現在）</td></tr>
      <tr><th>本社所在地</th><td>東京都港区芝浦3-1-1</td></tr>
      <tr><th>上場市場</th><td>東証プライム</td></tr>
      <tr><th>証券コード</th><td>6301</td></tr>
      <tr><th>業種</th><td>電気機器</td></tr>
      </table>
      <p>当社は産業用モーターおよび制御機器の開発・製造・販売を行っています。事業セグメントは産業システム事業、モビリティ事業、社会インフラ事業の3つです。</p>
      <p>主要製品はサーボモーター、インバータ、産業用ロボットコントローラです。</p>
      <p>収益は製品販売と保守サービス契約の組み合わせによって構成されています。</p>
      <p>主な顧客は自動車メーカー、工作機械メーカー、鉄道事業者です。</p>
      <p>海外展開として、中国・タイ・メキシコ・ドイツに生産拠点を有しています。</p>
      <p>グループ会社は大和電機システムズ株式会社、大和電機ロジスティクス株式会社です。</p>
      <p>当社の強みは、モーター単体ではなく制御ソフトウェアまで一貫して自社開発できる点にあります。</p>
      </body></html>`,
    'https://www.daiwa-denki.co.jp/philosophy/': `<html><head><title>経営理念</title></head><body>
      <h2>経営理念</h2><p>動かす技術で、社会の営みを支える。</p>
      <h2>ビジョン</h2><p>2035年までに、産業自動化のグローバルスタンダードとなる。</p>
      <h2>行動指針</h2><ul><li>現場に立つ</li><li>数字で語る</li><li>約束を守る</li></ul>
      </body></html>`,
    'https://www.daiwa-denki.co.jp/ir/library/': `<html><head><title>決算情報</title></head><body>
      <h2>2026年3月期 通期決算</h2>
      <p>売上高 8,420億円、営業利益 712億円、当期純利益 498億円。</p>
      <p>産業システム事業 売上高 4,120億円、モビリティ事業 売上高 2,800億円、社会インフラ事業 売上高 1,500億円。</p>
      <p>業績は自動化投資の需要拡大により増収増益となりました。</p>
      <h2>中期経営計画 2029</h2>
      <p>中期経営計画では、2029年3月期に売上高1兆円、営業利益率10%を掲げています。</p>
      <p>成長戦略の柱は、制御ソフトウェアのサブスクリプション化と、東南アジアでの現地生産比率の引き上げです。</p>
      <p>重点投資領域はパワー半導体、制御ソフトウェア、海外生産拠点です。</p>
      <p>課題として、パワー半導体の外部調達依存、海外人材の確保を認識しています。</p>
      <p>事業リスクとしては、為替変動、自動車産業の設備投資の循環性、地政学リスクを挙げています。</p>
      <p>市場環境として、産業自動化市場は年率6%で成長する見通しです。</p>
      <p>当社は国内産業用モーター市場でシェア第2位の地位にあります。</p>
      </body></html>`,
    'https://www.daiwa-denki.co.jp/recruit/': `<html><head><title>採用情報</title></head><body>
      <h2>求める人物像</h2><p>現場の課題を自分の言葉で定義し、周囲を巻き込んで動かせる人。</p>
      <h2>募集職種</h2><ul><li>機械設計</li><li>電気設計</li><li>制御ソフトウェア開発</li><li>生産技術</li><li>営業</li></ul>
      <h2>採用について</h2><p>技術系・事務系の職種別採用を行っています。</p>
      <h2>働く環境</h2><p>フレックスタイム制と在宅勤務制度を併用しています。</p>
      <h2>社風</h2><p>年次に関係なく設計判断を任せる文化があります。</p>
      <h2>育成</h2><ul><li>新入社員技術研修</li><li>海外トレーニー制度</li><li>社内技術認定制度</li></ul>
      <p>キャリア形成については、5年目に職種転換を選択できる制度を設けています。</p>
      </body></html>`,
    'https://www.daiwa-denki.co.jp/news/': `<html><head><title>ニュースリリース</title></head><body><ul>
      <li>2026年7月14日 タイ第2工場の稼働を開始</li>
      <li>2026年6月28日 産業用サーボモーター新シリーズ「DM-9」を発売</li>
      <li>2026年5月20日 制御ソフトウェア企業のソフテック株式会社を子会社化</li>
      <li>2026年4月11日 ドイツZ社と産業自動化領域で業務提携</li>
      <li>2026年4月1日 サステナビリティサイトを公開しました</li>
      </ul></body></html>`,
  },
  oracle: {
    profile: {
      legalName: '大和電機株式会社',
      industryLabel: '電気機器',
      businessDescription: '産業用モーターおよび制御機器の開発・製造・販売を行っています',
      businessSegments: ['産業システム事業', 'モビリティ事業', '社会インフラ事業'],
      mainProducts: ['サーボモーター', 'インバータ', '産業用ロボットコントローラ'],
      employeeCount: '28,450名（連結・2026年3月31日現在）',
      employeeCountAsOf: '2026年3月31日現在',
      capital: '1,204億円',
      capitalAsOf: '2026年3月31日現在',
      // ★ 「創業 1932年4月」を返す幻覚パターン。resolveFoundedYear が「設立」へ正す。
      foundedYear: '1932年4月',
      headquartersAddress: '東京都港区芝浦3-1-1',
      listingStatus: '東証プライム',
      tickerCode: '6301',
      representativeName: '佐藤 健一',
      representativeTitle: '代表取締役社長',
      businessModel: '製品販売と保守サービス契約の組み合わせ',
      targetCustomers: ['自動車メーカー', '工作機械メーカー', '鉄道事業者'],
      overseasPresence: '中国・タイ・メキシコ・ドイツに生産拠点を有しています',
      groupCompanies: ['大和電機システムズ株式会社', '大和電機ロジスティクス株式会社'],
      selfDescribedStrengths: ['制御ソフトウェアまで一貫して自社開発できる'],
      // ★ 幻覚: 本文に無い親会社。
      parentCompanyName: '大和ホールディングス株式会社',
    },
    philosophy: {
      missionStatement: '動かす技術で、社会の営みを支える。',
      visionStatement: '2035年までに、産業自動化のグローバルスタンダードとなる。',
      corporateValues: ['現場に立つ', '数字で語る', '約束を守る'],
    },
    ir: {
      fiscalPeriodLabel: '2026年3月期',
      revenue: '8,420億円',
      operatingProfit: '712億円',
      netProfit: '498億円',
      segmentPerformance: ['産業システム事業 売上高 4,120億円', 'モビリティ事業 売上高 2,800億円'],
      financialHighlights: '自動化投資の需要拡大により増収増益となりました',
      midTermPlanSummary: '2029年3月期に売上高1兆円、営業利益率10%を掲げています',
      growthStrategy: '制御ソフトウェアのサブスクリプション化と、東南アジアでの現地生産比率の引き上げ',
      strategicInvestmentAreas: ['パワー半導体', '制御ソフトウェア', '海外生産拠点'],
      statedChallenges: ['パワー半導体の外部調達依存', '海外人材の確保'],
      businessRisks: ['為替変動', '自動車産業の設備投資の循環性', '地政学リスク'],
      marketEnvironment: '産業自動化市場は年率6%で成長する見通しです',
      marketPositionClaims: ['国内産業用モーター市場でシェア第2位'],
      // ★ 幻覚: 本文に競合名は 1 つも無い。
      namedCompetitors: ['安川電機', 'ファナック'],
    },
    recruiting: {
      desiredCandidateProfile: '現場の課題を自分の言葉で定義し、周囲を巻き込んで動かせる人',
      recruitingOverview: '技術系・事務系の職種別採用を行っています',
      jobCategories: ['機械設計', '電気設計', '制御ソフトウェア開発', '生産技術', '営業'],
      organizationalCulture: '年次に関係なく設計判断を任せる文化があります',
      workingStyle: 'フレックスタイム制と在宅勤務制度を併用しています',
      trainingPrograms: ['新入社員技術研修', '海外トレーニー制度', '社内技術認定制度'],
      careerDevelopment: '5年目に職種転換を選択できる制度を設けています',
    },
    developments: {
      recentDevelopments: [
        '2026年7月14日 タイ第2工場の稼働を開始',
        '2026年6月28日 産業用サーボモーター新シリーズ「DM-9」を発売',
        '2026年5月20日 制御ソフトウェア企業のソフテック株式会社を子会社化',
      ],
      productLaunches: ['2026年6月28日 産業用サーボモーター新シリーズ「DM-9」を発売'],
      partnerships: ['2026年4月11日 ドイツZ社と産業自動化領域で業務提携'],
      mergersAcquisitions: ['2026年5月20日 制御ソフトウェア企業のソフテック株式会社を子会社化'],
    },
  },
  planted: [
    ['parentCompanyName', '大和ホールディングス株式会社'],
    ['namedCompetitors', '安川電機'],
    ['namedCompetitors', 'ファナック'],
  ],
};

// ── B: tech ベンチャー（IR / 理念ページが無い・採用とニュースは厚い）──────
const TECH: Fixture = {
  label: 'B tech ベンチャー（情報量: 中）',
  note: '非上場のため IR 無し。理念は会社概要ページに同居',
  host: 'kumo-lab.jp',
  origin: 'https://kumo-lab.jp',
  displayName: '株式会社クモラボ',
  registry: {
    corporateNumber: '9876543210987',
    legalName: '株式会社クモラボ',
    legalNameKana: 'クモラボ',
    legalNameEn: null,
    prefecture: '東京都',
    address: '東京都渋谷区桜丘町2-2',
    registrationStatus: '存続',
    formerNames: [],
  },
  pages: {
    'https://kumo-lab.jp/': `<html><head><title>株式会社クモラボ</title></head><body>
      <h1>株式会社クモラボ</h1>
      ${nav('https://kumo-lab.jp', [
        ['/company/', '会社概要'],
        ['/recruit/', '採用'],
        ['/news/', 'お知らせ'],
      ])}</body></html>`,
    'https://kumo-lab.jp/company/': `<html><head><title>会社概要 | 株式会社クモラボ</title></head><body>
      <dl>
      <dt>会社名</dt><dd>株式会社クモラボ</dd>
      <dt>代表者</dt><dd>代表取締役 鈴木 遥</dd>
      <dt>設立</dt><dd>2018年9月3日</dd>
      <dt>資本金</dt><dd>1億2,000万円</dd>
      <dt>従業員数</dt><dd>78名（2026年4月現在）</dd>
      <dt>所在地</dt><dd>東京都渋谷区桜丘町2-2</dd>
      <dt>事業内容</dt><dd>クラウド型在庫管理SaaS「クモストック」の開発・提供</dd>
      </dl>
      <p>ミッションは「在庫のムダをゼロにする」です。</p>
      <p>収益はSaaSの月額サブスクリプション課金によって構成されています。</p>
      <p>主な顧客は中小の卸売業者とEC事業者です。</p>
      <p>私たちの強みは、導入から定着までを自社カスタマーサクセスチームが伴走することです。</p>
      </body></html>`,
    'https://kumo-lab.jp/recruit/': `<html><head><title>採用</title></head><body>
      <h2>こんな人と働きたい</h2><p>正解が無い状態で、まず動いて検証できる人。</p>
      <h2>職種</h2><ul><li>ソフトウェアエンジニア</li><li>カスタマーサクセス</li><li>セールス</li></ul>
      <h2>働き方</h2><p>フルリモート可、コアタイム無しのフレックス制です。</p>
      <h2>カルチャー</h2><p>意思決定の経緯を全社に文章で残す文化があります。</p>
      </body></html>`,
    'https://kumo-lab.jp/news/': `<html><head><title>お知らせ</title></head><body><ul>
      <li>2026年6月 シリーズBラウンドで12億円を調達</li>
      <li>2026年5月 「クモストック」にAI需要予測機能を追加</li>
      <li>2026年3月 オフィスを移転しました</li>
      </ul></body></html>`,
  },
  oracle: {
    profile: {
      legalName: '株式会社クモラボ',
      businessDescription: 'クラウド型在庫管理SaaS「クモストック」の開発・提供',
      mainProducts: ['クモストック'],
      employeeCount: '78名（2026年4月現在）',
      employeeCountAsOf: '2026年4月現在',
      capital: '1億2,000万円',
      foundedYear: '2018年9月3日',
      headquartersAddress: '東京都渋谷区桜丘町2-2',
      representativeName: '鈴木 遥',
      representativeTitle: '代表取締役',
      businessModel: 'SaaSの月額サブスクリプション課金',
      targetCustomers: ['中小の卸売業者', 'EC事業者'],
      selfDescribedStrengths: ['導入から定着までを自社カスタマーサクセスチームが伴走する'],
      // ★ 幻覚: 上場していないのに上場区分を返す。
      listingStatus: '東証グロース',
    },
    // 理念ページは無いので、会社概要本文から理念を取る経路になる。
    philosophy: { missionStatement: '在庫のムダをゼロにする' },
    recruiting: {
      desiredCandidateProfile: '正解が無い状態で、まず動いて検証できる人',
      jobCategories: ['ソフトウェアエンジニア', 'カスタマーサクセス', 'セールス'],
      workingStyle: 'フルリモート可、コアタイム無しのフレックス制です',
      organizationalCulture: '意思決定の経緯を全社に文章で残す文化があります',
    },
    developments: {
      recentDevelopments: ['2026年6月 シリーズBラウンドで12億円を調達', '2026年5月 「クモストック」にAI需要予測機能を追加'],
      productLaunches: ['2026年5月 「クモストック」にAI需要予測機能を追加'],
    },
  },
  planted: [['listingStatus', '東証グロース']],
};

// ── C: 情報量の少ない中小企業（トップ 1 枚のみ・registry も引けない）────────
const SMALL: Fixture = {
  label: 'C 情報量の少ない中小企業（情報量: 少）',
  note: 'トップ 1 枚だけ。会社概要ページ / 採用ページ / IR いずれも無い',
  host: 'kitamura-seisakusho.com',
  origin: 'https://kitamura-seisakusho.com',
  displayName: '北村製作所株式会社',
  // 中小でも法人番号は引ける（identity group は registry から埋まる）。
  //   ★ registry が引けない企業は identity 解決の段で止まる（既存 Company Identity の
  //     「公的 registry で裏が取れた企業だけ新規作成する」不変条件）。それは本 smoke の
  //     対象ではないため、ここでは「解決はできるが **サイトに情報が無い**」型を測る。
  registry: {
    corporateNumber: '5555555555555',
    legalName: '北村製作所株式会社',
    legalNameKana: 'キタムラセイサクショ',
    legalNameEn: null,
    prefecture: '新潟県',
    address: '新潟県長岡市上前島町1-2',
    registrationStatus: '存続',
    formerNames: [],
  },
  pages: {
    'https://kitamura-seisakusho.com/': `<html><head><title>北村製作所株式会社</title></head><body>
      <h1>北村製作所</h1>
      <p>金属プレス加工の北村製作所です。창業以来、精密板金の受託加工を行っています。</p>
      <p>所在地: 新潟県長岡市上前島町1-2　電話: 0258-00-0000</p>
      </body></html>`,
  },
  oracle: {
    profile: {
      legalName: '北村製作所',
      businessDescription: '精密板金の受託加工を行っています',
      headquartersAddress: '新潟県長岡市上前島町1-2',
      // ★ 幻覚: 本文に無い従業員数・設立年。
      employeeCount: '約30名',
      foundedYear: '1965年4月',
    },
  },
  planted: [
    ['employeeCount', '約30名'],
    ['foundedYear', '1965年4月'],
  ],
};

// ════════════════════════════════════════════════════════════════════
// fixture → deps（ネットワーク・DB・LLM だけを差し替える）
// ════════════════════════════════════════════════════════════════════
type Captured = { rows: FactRow[]; status: string | null; fetches: string[]; extractions: string[] };

function siteDocFrom(url: string, html: string): SiteDocument {
  return {
    url,
    text: htmlToText(html),
    title: extractTitle(html),
    links: extractLinks(html, url),
    jsonLd: extractJsonLdOrganization(html),
    source: {
      sourceUrl: url,
      sourceType: 'official_site',
      sourceDomain: new URL(url).hostname,
      httpStatus: 200,
      contentHash: null,
      fetchedAt: NOW,
      publishedAt: null,
    },
  };
}

function depsFor(fixture: Fixture, captured: Captured): PrefetchDeps {
  const registrySource: ProviderSourceRef = {
    sourceUrl: `https://api.houjin-bangou.nta.go.jp/4/name?name=${encodeURIComponent(fixture.displayName)}`,
    sourceType: 'corporate_registry',
    sourceDomain: 'api.houjin-bangou.nta.go.jp',
    httpStatus: 200,
    contentHash: null,
    fetchedAt: NOW,
    publishedAt: null,
  };

  /** ページ別 oracle を返す（無ければ null ＝ 抽出できなかった）。 */
  const oracleFor = (kind: keyof Fixture['oracle'], label: string) => async () => {
    captured.extractions.push(label);
    const raw = fixture.oracle[kind];
    return raw ?? null;
  };

  return {
    now: () => NOW,
    externalFetchEnabled: () => true,

    registry: {
      name: 'fixture-registry',
      isConfigured: () => fixture.registry !== null,
      lookupByName: async () =>
        fixture.registry
          ? { status: 'resolved', candidate: fixture.registry, source: registrySource }
          : { status: 'unresolved', source: null },
    },
    search: {
      name: 'fixture-search',
      isConfigured: () => true,
      searchOfficialSite: async () => ({
        status: 'ok',
        hits: [{ url: `${fixture.origin}/`, title: fixture.displayName, snippet: '' }],
        source: {
          sourceUrl: 'https://search.example/?q=company',
          sourceType: 'search_result',
          sourceDomain: 'search.example',
          httpStatus: 200,
          contentHash: null,
          fetchedAt: NOW,
          publishedAt: null,
        },
      }),
    },
    fetchSite: async (url) => {
      captured.fetches.push(url);
      const html = fixture.pages[url];
      if (html === undefined) return { ok: false };
      return { ok: true, document: siteDocFrom(url, html) };
    },

    // ── LLM の代わりに oracle（+ 幻覚）を返す。検証は本物が行う ─────────
    extractProfile: async () => {
      const raw = await oracleFor('profile', 'profile')();
      return raw === null ? null : normalizeExtractedProfile(raw);
    },
    extractPhilosophy: async () => {
      const raw = await oracleFor('philosophy', 'philosophy')();
      return raw === null ? null : normalizeBySpec<ExtractedCompanyPhilosophy>(raw, PHILOSOPHY_SPEC);
    },
    extractIr: async () => {
      const raw = await oracleFor('ir', 'ir')();
      return raw === null ? null : normalizeBySpec<ExtractedCompanyIr>(raw, IR_SPEC);
    },
    extractRecruiting: async () => {
      const raw = await oracleFor('recruiting', 'recruiting')();
      return raw === null ? null : normalizeBySpec<ExtractedCompanyRecruiting>(raw, RECRUITING_SPEC);
    },
    extractDevelopments: async () => {
      const raw = await oracleFor('developments', 'developments')();
      return raw === null ? null : normalizeBySpec<ExtractedCompanyDevelopments>(raw, DEVELOPMENTS_SPEC);
    },

    registerCompany: async (displayName) => ({
      status: 'registered',
      companyId: 'cmp_fixture',
      displayName,
      created: true,
    }),
    resolveExistingCompany: async () => null,

    loadFreshness: async () => new Map<CompanyFactGroup, CompanyFactGroupState>(),
    claimJob: async () => ({ outcome: 'CLAIMED_NEW', jobId: 'job_1', attemptToken: 'tok_1' }),
    insertSources: async (_companyId, sources) => new Map(sources.map((s) => [s.sourceUrl, `src_${s.sourceUrl}`])),
    insertFacts: async (facts, sourceIdByUrl) => {
      // repository.server.ts と同じ「source 未解決なら書かない」規則を再現する。
      let written = 0;
      for (const f of facts) {
        if (!sourceIdByUrl.get(f.sourceUrl)) continue;
        written += 1;
        captured.rows.push({
          factKey: f.factKey,
          factGroup: f.factGroup,
          // jsonb 往復を模す（直列化で消えないことを同時に確認する）。
          factValue: JSON.parse(JSON.stringify(f.factValue)) as unknown,
          sourceUrl: f.sourceUrl,
          sourceType: f.sourceUrl.includes('houjin-bangou') ? 'corporate_registry' : 'official_site',
          extractionMethod: f.extractionMethod,
          fetchedAt: f.fetchedAt,
        });
      }
      return written;
    },
    finishJob: async (args) => {
      captured.status = args.status;
      return { applied: true };
    },
    failJob: async () => {
      captured.status = 'failed';
      return { applied: true };
    },
    buildIdentity: (companyId) => buildCompanyEnrichmentIdentity({ companyId }),
  };
}

// ════════════════════════════════════════════════════════════════════
async function report(fixture: Fixture): Promise<{ label: string; got: number; leaked: string[] }> {
  const captured: Captured = { rows: [], status: null, fetches: [], extractions: [] };
  const outcome = await runCompanyPrefetch(depsFor(fixture, captured), fixture.displayName);

  const got = new Set(captured.rows.map((r) => r.factKey));
  const byGroup = new Map<CompanyFactGroup, number>();
  for (const key of got) {
    const g = COMPANY_FACT_KEY_GROUP[key as CompanyFactKey];
    if (g) byGroup.set(g, (byGroup.get(g) ?? 0) + 1);
  }

  // 仕込んだ幻覚が保存されていないこと（保存されたら leaked ＝ grounding 検証の穴）。
  const blocked: string[] = [];
  const leaked: string[] = [];
  for (const [key, value] of fixture.planted) {
    const stored = captured.rows.filter((r) => r.factKey === key);
    const raw = JSON.stringify(stored.map((r) => (r.factValue as { value?: unknown })?.value ?? ''));
    (raw.includes(value) ? leaked : blocked).push(`${key}="${value}"`);
  }

  const ctx = buildCompanyOfficialContext({
    companyId: 'cmp_fixture',
    displayName: fixture.displayName,
    rows: captured.rows,
    nowIso: NOW,
  });
  const block = renderCompanyOfficialForPurpose('company_research_review', { status: 'ready', data: ctx });
  const bytes = new TextEncoder().encode(block.text).length;

  console.log(`\n── ${fixture.label}`);
  console.log(`   ${fixture.note}`);
  console.log(`   job outcome        : ${outcome.kind}${'status' in outcome ? ` / ${outcome.status}` : ''} (terminal=${captured.status})`);
  console.log(`   fetch 回数         : ${captured.fetches.length}（${captured.fetches.length ? captured.fetches.map((u) => new URL(u).pathname).join(' ') : '-'}）`);
  console.log(`   抽出したページ     : ${captured.extractions.join(', ') || '-'}`);
  console.log(`   取得 fact          : ${got.size} / ${COMPANY_FACT_KEYS.length}`);
  console.log(
    `   group 別           : ${[...PREFETCH_FACT_GROUPS, ...OPPORTUNISTIC_FACT_GROUPS]
      .map((g) => `${g}=${byGroup.get(g) ?? 0}`)
      .join(' ')}`,
  );
  console.log(`   幻覚を落とした項目 : ${blocked.join(', ') || '（仕込み無し）'}`);
  console.log(`   ★ 保存された幻覚   : ${leaked.join(', ') || 'なし'}`);
  console.log(`   prompt block       : ${bytes} bytes / used=${block.used}`);
  console.log(`   欠損（正常）       : ${COMPANY_FACT_KEYS.filter((k) => !got.has(k)).length} 項目 → null のまま保存しない`);

  return { label: fixture.label, got: got.size, leaked };
}

async function main(): Promise<void> {
  console.log('Company Data Spine — 項目カバレッジ smoke test');
  console.log(`fact schema     : ${COMPANY_FACT_SCHEMA_REVISION}（key 総数 ${COMPANY_FACT_KEYS.length}）`);
  console.log('★ ネットワーク / DB / LLM のみ fake。grounding 検証・fact mapping・renderer は本物。');

  const results = [];
  for (const fixture of [LARGE, TECH, SMALL]) results.push(await report(fixture));

  console.log('\n── まとめ');
  for (const r of results) console.log(`   ${r.label}: ${r.got}/${COMPANY_FACT_KEYS.length} 項目`);
  console.log('\n★ 少ない企業で項目が埋まらないのは **正常**（推測で埋めない設計）。');
  console.log('★ 仕込んだ幻覚がすべて落ちていれば、grounding 検証が機能している。');

  // smoke だが、次の 2 つは明確な異常なので落とす。
  const leaked = results.flatMap((r) => r.leaked);
  if (leaked.length > 0) {
    console.error(`\n❌ 幻覚が保存された: ${leaked.join(', ')}`);
    process.exit(1);
  }
  if (results.every((r) => r.got === 0)) {
    console.error('\n❌ どの企業でも 1 件も取得できていない（pipeline が壊れている）');
    process.exit(1);
  }
  console.log('\n✅ 仕込んだ幻覚はすべて落ち、情報量の差がそのままカバレッジの差に出ている');
}

void main();
