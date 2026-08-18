import type { Metadata } from 'next';
import Link from 'next/link';

import { LegalSection } from '@/components/legal/LegalSection';
import { PageHeader } from '@/components/ui/PageHeader';
import { FooterSection } from '@/app/components/landing/FooterSection';
import { CONTACT_EMAIL } from '@/lib/legal';

// STEP-LEGAL-02: PASSAI の正式プライバシーポリシー (初版)。
// STEP-LEGAL-03: PASSAI CAREER (新卒就活版) の取得情報・保存・委託先を追加 (2026-08-18)。
//
// LEGAL-01 利用規約との整合性:
//   - 「当サービス」呼称統一 / ます調 / 制定日揃え (2026-06-02)
//   - 利用規約 第11条 (知的財産権) の "サービス提供、運用、品質改善、不正利用防止、
//     匿名化された統計分析、研究開発" を利用目的として本ポリシーに具体化
//   - 利用規約 LEGAL-01 残課題だった「未成年者の保護者同意」を本ポリシー第 10 条で補完
//   - 利用規約 第4条 のカード情報非保持を本ポリシー第 2 / 8 条で再明示
//
// STEP-LEGAL-03 で追記した CAREER の事実は、すべて現行コードから実証したものだけに限る:
//   - localStorage が canonical、ログイン時のみ Supabase (CAREER 専用プロジェクト) へ
//     ミラーする … app/career/*/*Storage.ts + lib/supabase/career*.ts
//   - AI は Anthropic Claude のみ。CAREER は OpenAI を呼ばない
//     … app/api/career/** に OPENAI_API_KEY 参照なし (受験版のみが音声認識で利用)
//   - 面接の音声認識はブラウザの Web Speech API。当サービスのサーバは音声を受信しない
//     … app/career/interview/useVoice.ts
//   - 企業研究のアップロード資料はテキスト抽出後に破棄し、ファイル本体を保存しない
//     … app/api/career/company-research/extract/route.ts
//   - GD マルチプレイの発言は同じ部屋の参加者に表示される
//     … app/api/career/gd/room/[roomId]/messages/route.ts
//   ★ 保持期間・削除 SLA など、コードから実証できない新しい条件は追加しない。
//
// 文体: スタートアップ SaaS として自然なます調、平易な日本語、当サービス/ユーザー統一。

export const metadata: Metadata = {
  title: 'プライバシーポリシー | PASSAI',
  description:
    'PASSAI および PASSAI CAREER が取得する情報の種類・利用目的・第三者提供・保存期間・ユーザーの権利について定めたプライバシーポリシーです。',
};

const ENACTED_AT = '2026年6月2日';
// 2026-06-17: プレゼン対策の録画動画・発表資料を原則 90 日で自動削除する旨、および発表後 Q&A
//   練習（質問・回答・AI フィードバック）をアカウント有効期間 保存する旨の追記に伴う改定。
//   (文字起こし・AI 評価結果はアカウント有効期間の保存を維持。)
// 2026-08-18: PASSAI CAREER (新卒就活版) の取得情報・保存場所・委託先を追記した改定。
const LAST_REVISED_AT = '2026年8月18日';

export default function PrivacyPage() {
  return (
    <div className="bg-white">
      <div className="mx-auto max-w-3xl px-4 sm:px-6 py-12 sm:py-16">
        <Link
          href="/"
          className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800 mb-8 transition-colors"
        >
          ← トップに戻る
        </Link>

        <PageHeader title="プライバシーポリシー" />

        <p className="text-sm text-slate-500 mb-8">
          制定日: {ENACTED_AT}
          <span className="mx-2">/</span>
          最終改定日: {LAST_REVISED_AT}
        </p>

        <div className="space-y-3 text-slate-700 leading-relaxed mb-10">
          <p className="text-sm">
            PASSAI 運営チーム (以下「当サービス」) は、大学受験向けサービス「PASSAI」
            および新卒就活向けサービス「PASSAI CAREER」 (以下あわせて「本サービス」)
            を提供するにあたり、ユーザー (以下「ユーザー」)
            から取得する情報の取り扱いについて本プライバシーポリシー (以下「本ポリシー」)
            を定めます。本ポリシーは{' '}
            <Link href="/terms" className="text-brand-700 hover:underline">
              利用規約
            </Link>{' '}
            と一体のものとして適用されます。
          </p>
          <p className="text-sm">
            本ポリシーは両サービスに共通して適用されます。いずれか一方にのみ該当する
            事項については、その旨を明記します。
          </p>
        </div>

        <div className="space-y-8">
          <LegalSection number={1} title="基本方針">
            <p>
              当サービスは、ユーザーの個人情報を適切に取り扱うことが社会的責務であると
              考え、個人情報の保護に関する法律をはじめとする関連法令を遵守し、本ポリシーに
              基づき個人情報を取り扱います。
            </p>
          </LegalSection>

          <LegalSection number={2} title="取得する情報">
            <p>
              当サービスは、本サービスの提供にあたり以下の情報を取得します。
            </p>
            <ul className="list-disc pl-5 space-y-2">
              <li>
                <strong>アカウント情報</strong>: 匿名認証ID
                (Supabase Auth が発行する UUID)、登録された場合のメールアドレス、
                ユーザーが任意に設定する表示用ユーザーID
              </li>
              <li>
                <strong>決済関連情報</strong>: Stripe Customer ID、購読プラン
                (Basic / Premium / Free)、購読状態 (active / canceled / past_due 等)、
                次回更新日。
                <br />
                <span className="text-slate-500">
                  ※ カード番号、有効期限、セキュリティコード等の決済情報は Stripe, Inc.
                  が直接取得し、当サービスのサーバには保存されません。
                </span>
              </li>
              <li>
                <strong>利用履歴</strong>: AI 機能の利用回数、利用日時、利用機能の
                識別子、利用モデル、処理結果のステータス (成功 / エラー / 利用上限超過)
              </li>
              <li>
                <strong>ユーザーが入力した内容 (PASSAI / 大学受験向け)</strong>:
                <ul className="list-disc pl-5 mt-1 space-y-0.5 text-slate-600">
                  <li>志望理由書原稿、整理メモ</li>
                  <li>小論文原稿、改善方針メモ</li>
                  <li>自己分析の回答、深掘りメモ、自由メモ</li>
                  <li>面接質問、回答、フィードバック対象データ</li>
                  <li>自己PR の本文</li>
                  <li>Tutor の会話履歴</li>
                  <li>基本情報 (学年、志望校・志望学部、受験方式、評定等)</li>
                </ul>
              </li>
              <li>
                <strong>ユーザーが入力した内容 (PASSAI CAREER / 新卒就活向け)</strong>:
                <ul className="list-disc pl-5 mt-1 space-y-0.5 text-slate-600">
                  <li>
                    基本情報 (ニックネーム、学年、卒業予定年、大学・学部・学科、
                    性別 (任意))
                  </li>
                  <li>
                    活動整理の内容 (学業、サークル、アルバイト、インターン、留学・海外
                    経験、資格、語学、趣味・特技、表彰・実績等)
                  </li>
                  <li>
                    就活軸整理の選択内容および自由記述 (重視する条件、避けたい条件、
                    志望業界・職種、働き方、社風等)
                  </li>
                  <li>自己分析の回答、深掘りの質問と回答、まとめ結果</li>
                  <li>
                    エントリーシートの設問、下書き、本文、深掘りの質問と回答、
                    整理メモ、AI による添削結果
                  </li>
                  <li>
                    志望企業名、志望業界、志望職種、選考種別など、各機能で指定した
                    企業・選考に関する情報
                  </li>
                  <li>
                    面接練習の質問、回答内容 (音声から変換されたテキスト)、および評価結果
                  </li>
                  <li>
                    グループディスカッション練習のテーマ、発言内容、および評価結果
                  </li>
                  <li>
                    プレゼン対策のお題、発表内容、質疑応答、および評価結果
                  </li>
                  <li>
                    企業研究メモ、および添削のためにアップロードされた資料から抽出した
                    テキスト
                  </li>
                  <li>就活相談AI との会話履歴</li>
                  <li>
                    各機能の利用イベント (どの機能をいつ利用したかの記録。入力本文は
                    含みません)
                  </li>
                </ul>
                <span className="text-slate-500">
                  ※ PASSAI CAREER では、これらの情報はまずご利用中のブラウザ内
                  (ローカルストレージ) に保存されます。メールアドレスでログインしている
                  場合に限り、同じ内容が当サービスのデータベースにも保存されます
                  (第 7 条参照)。
                </span>
              </li>
              <li>
                <strong>PASSAI CAREER の面接練習における音声の取り扱い</strong>:
                <ul className="list-disc pl-5 mt-1 space-y-0.5 text-slate-600">
                  <li>
                    面接練習では、ブラウザに標準で搭載されている音声認識機能を利用して
                    発話をテキストに変換します。
                  </li>
                  <li>
                    当サービスのサーバは音声データそのものを受信・保存しません。保存
                    されるのは変換後のテキストのみです。
                  </li>
                  <li>
                    ブラウザによっては、音声認識の処理がブラウザ提供事業者 (Google、
                    Apple 等) のサーバで行われる場合があります。その場合の音声データの
                    取り扱いは、当該ブラウザ提供事業者のプライバシーポリシーに従います。
                  </li>
                </ul>
              </li>
              <li>
                <strong>
                  PASSAI CAREER の企業研究でアップロードされた資料
                </strong>
                : 企業研究の入力補助として PDF・画像ファイルをアップロードできます。
                <span className="text-slate-500">
                  ※ アップロードされたファイルは、記載されている文字を抽出する目的での
                  み処理し、<strong>ファイル本体は保存しません</strong> (抽出後に破棄
                  します)。保存されるのは、ユーザーが確認・編集したうえで企業研究メモへ
                  反映したテキストのみです。
                </span>
              </li>
              <li>
                <strong>プレゼン対策の録画・評価データ</strong> (Premium 限定機能):
                <ul className="list-disc pl-5 mt-1 space-y-0.5 text-slate-600">
                  <li>
                    録画動画 (映像・音声を含む)。発表の見返しおよび AI 評価の補助
                    データとして保存します。
                  </li>
                  <li>録画音声から生成した文字起こしテキスト</li>
                  <li>
                    AI によるカテゴリ評価結果 (構成力・説得力・具体性 等)、講評
                  </li>
                  <li>
                    発表後 Q&A 練習における質問、入力した回答内容、および AI による
                    フィードバック (学習履歴として保存します)
                  </li>
                </ul>
                <span className="text-slate-500">
                  ※ 文字起こしのために録画音声を外部の音声認識サービスへ送信しますが、
                  送信した音声ファイル自体は保存せず、文字起こしテキストのみを保存します。
                </span>
              </li>
              <li>
                <strong>アクセスログ</strong>: IPアドレス、ブラウザ種別、リクエスト日時、
                参照ページ等 (ホスティング基盤および Web アプリケーションのサーバが
                技術的に取得する情報)
              </li>
            </ul>
          </LegalSection>

          <LegalSection number={3} title="利用目的">
            <p>取得した情報は、以下の目的の達成に必要な範囲で利用します。</p>
            <ol className="list-decimal pl-5 space-y-1">
              <li>本サービスの提供および機能の継続的な改善</li>
              <li>アカウントの認証および管理</li>
              <li>有料プランの課金処理および購読状態の同期</li>
              <li>AI 機能 (Anthropic Claude) への入力および推論結果の取得</li>
              <li>
                サービス品質の向上、不具合の検出と修正、利用パターンの分析
              </li>
              <li>匿名化されたデータでの統計分析および研究開発</li>
              <li>不正利用、利用規約違反、セキュリティ脅威の検出と防止</li>
              <li>ユーザーからのお問い合わせへの対応</li>
              <li>
                利用規約・本ポリシーの変更、メンテナンス情報、その他の重要なお知らせの送信
              </li>
            </ol>
          </LegalSection>

          <LegalSection number={4} title="第三者提供と業務委託">
            <p>
              当サービスは、法令で認められる場合 (司法手続き、生命・身体・財産の保護等)
              を除き、ユーザーの同意なく個人情報を第三者に提供することはありません。
            </p>
            <p>
              ただし、本サービスの提供にあたり、以下の事業者に処理の一部を委託しており、
              必要な範囲で情報を提供します。各事業者と適切な取扱契約を締結し、安全管理が
              行われるよう努めます。
            </p>
            <ul className="list-disc pl-5 space-y-2">
              <li>
                <strong>Stripe, Inc.</strong> (米国) — 決済処理。取扱情報:
                メールアドレス、Stripe Customer ID、購読情報、決済カード情報
                (ユーザーが Stripe Checkout で直接入力)
              </li>
              <li>
                <strong>Anthropic, PBC</strong> (米国) — AI 推論 (Claude API)。
                取扱情報: ユーザーが AI 機能に入力した文章。
                <br />
                <span className="text-slate-500">
                  PASSAI: 志望理由書、小論文、自己分析の回答、面接質問・回答、Tutor への
                  質問、プレゼンの文字起こし・発表内容・発表後 Q&A の回答等。
                  <br />
                  PASSAI CAREER: 基本情報、活動整理、就活軸整理、自己分析の回答、
                  エントリーシートの設問・本文・深掘り回答、面接練習の質問・回答、
                  グループディスカッションの発言、プレゼンの発表内容・質疑応答、
                  企業研究メモ、アップロード資料から抽出したテキスト、就活相談の会話等。
                  <br />
                  PASSAI CAREER の AI 機能は、すべて Anthropic Claude のみを利用します。
                </span>
              </li>
              <li>
                <strong>OpenAI, L.L.C.</strong> (米国) — 音声認識 (文字起こし)。
                取扱情報: 面接 AI・プレゼン対策の録音／録画から抽出した音声データ
                (文字起こしのために送信。文字起こし後の音声ファイルは保存しません)
                <br />
                <span className="text-slate-500">
                  ※ 本項は PASSAI (大学受験向け) の機能に限られます。PASSAI CAREER は
                  OpenAI を利用しません (面接練習の音声認識はブラウザの機能を利用します。
                  第 2 条参照)。
                </span>
              </li>
              <li>
                <strong>Supabase, Inc.</strong> (米国) — データベースおよび認証基盤。
                取扱情報: アカウント情報、メールアドレス、利用履歴、購読状態、
                ユーザー入力内容のうちサーバ側で保存するもの
                <br />
                <span className="text-slate-500">
                  ※ PASSAI と PASSAI CAREER は、それぞれ独立した Supabase プロジェクト
                  (データベース) を使用しており、両サービスのデータは相互に混在しません。
                </span>
              </li>
              <li>
                <strong>Vercel, Inc.</strong> (米国) — ホスティング、CDN、エッジ配信。
                取扱情報: アクセスログ、リクエスト・レスポンスのメタデータ
              </li>
            </ul>
            <p className="text-xs text-slate-500">
              各事業者のプライバシーポリシーは、各社の公式サイトをご確認ください。
            </p>

            <p className="font-semibold text-slate-900 mt-4">
              他のユーザーに表示される情報 (PASSAI CAREER)
            </p>
            <p>
              PASSAI CAREER のグループディスカッション練習を他のユーザーと同じ部屋で
              行う場合、その部屋の中では以下の情報が他の参加者に表示されます。これは
              練習の性質上必要な範囲に限られ、第三者提供ではありません。
            </p>
            <ul className="list-disc pl-5 space-y-1">
              <li>ディスカッション中の発言内容</li>
              <li>表示名 (基本情報で設定したニックネーム)</li>
              <li>担当した役割および参加状況</li>
            </ul>
            <p className="text-xs text-slate-500">
              ※ メールアドレス、アカウント ID、参加コードのハッシュ等は他の参加者に
              表示されません。ディスカッションの内容には、ご自身や第三者を特定できる
              情報を必要以上に含めないようご注意ください。
            </p>
          </LegalSection>

          <LegalSection number={5} title="越境データ転送">
            <p>
              前項のとおり、本サービスは米国に拠点を置く事業者を利用しています。そのため、
              ユーザーの個人情報および本サービスに入力された情報は、日本国外
              (主に米国) のデータセンターで処理・保存される可能性があります。
            </p>
            <p>
              当サービスは、これらの事業者が個人情報保護のために適切な安全管理措置を
              講じていることを利用開始時およびその後定期的に確認します。
            </p>
          </LegalSection>

          <LegalSection number={6} title="Cookie および類似技術">
            <p>
              当サービスは、本サービスの提供のために以下の用途で Cookie および
              ローカルストレージ等の類似技術を利用します。
            </p>
            <ul className="list-disc pl-5 space-y-1">
              <li>
                認証セッションの維持 (Supabase Auth が発行する認証 Cookie)
              </li>
              <li>
                ユーザーの作業状態の保持 (志望理由書下書き、自己分析回答、面接記録等の
                ローカルストレージ保存)
              </li>
              <li>
                PASSAI CAREER における入力内容の保存。PASSAI CAREER では、第 2 条に
                記載した入力内容 (活動整理、就活軸整理、自己分析、エントリーシート、
                面接・GD・プレゼンの記録、企業研究メモ、就活相談の履歴等) を、
                <strong>ログインの有無にかかわらずローカルストレージに保存します</strong>。
                ログインしていない場合、これらはご利用中のブラウザ内にのみ存在します。
              </li>
              <li>サービスの基本的な動作維持に必要な技術的識別子</li>
            </ul>
            <p className="text-sm text-slate-600">
              ※ ブラウザのデータ (サイトデータ・ローカルストレージ) を削除すると、
              PASSAI CAREER でログインせずに入力した内容は復元できません。別の端末や
              ブラウザとの引き継ぎ、および削除からの復元をご希望の場合は、
              メールアドレスでのログインをご利用ください。
            </p>
            <p>
              当サービスは、広告配信および第三者によるトラッキングを目的とした Cookie を
              使用していません。
            </p>
            <p>
              ユーザーは、ブラウザの設定により Cookie の受け入れを拒否することができます。
              ただし、その場合は本サービスの一部機能 (ログイン、購読状態の同期、入力内容
              の保持等) が正常に動作しない可能性があります。
            </p>
          </LegalSection>

          <LegalSection number={7} title="情報の保存期間">
            <p>
              当サービスは、取得した情報を本サービスの提供および各利用目的の達成に必要な
              期間、保存します。具体的な目安は以下のとおりです。
            </p>
            <ul className="list-disc pl-5 space-y-1">
              <li>
                <strong>アカウント情報・メールアドレス</strong>: アカウントが有効である期間
              </li>
              <li>
                <strong>購読状態 (subscriptions)</strong>: アカウントが有効である期間
                (解約後も契約履歴として保存)
              </li>
              <li>
                <strong>利用履歴 (AI 利用回数等)</strong>: 課金集計および品質分析の目的で
                取得から 24 ヶ月程度を目安に保存
              </li>
              <li>
                <strong>ユーザーが入力した文章</strong>: ユーザーがアカウントを利用して
                いる期間、ブラウザ側のローカルストレージおよびサーバ側のデータベースに保存
              </li>
              <li>
                <strong>PASSAI CAREER の入力内容</strong>: ブラウザのローカルストレージ
                には、ユーザーが削除するか、ブラウザのサイトデータを消去するまで保存
                されます。メールアドレスでログインしている場合は、同じ内容がアカウントが
                有効である期間、当サービスのデータベースにも保存されます。ユーザーは
                各機能の履歴画面から個別に削除できるほか、第 9 条に基づく削除請求を
                行うことができます。
              </li>
              <li>
                <strong>PASSAI CAREER のグループディスカッションの部屋・発言記録</strong>:
                練習の進行および結果表示のためにデータベースへ保存されます。使用が
                終了した部屋および長時間放置された部屋は、定期的な整理処理により削除
                されます。
              </li>
              <li>
                <strong>プレゼン対策の録画動画・発表資料</strong>: 録画動画および
                アップロードされた発表資料 (PDF・画像) は、クラウドストレージに保存され
                ご本人のみが閲覧できます。これらのファイルは、ストレージ費用および
                プライバシー保護の観点から、<strong>作成からおおむね 90 日が経過すると
                自動的に削除されます</strong>。削除後は録画の再生・資料の閲覧はできなくなり、
                結果画面・履歴ではその旨を表示します。なお、ユーザーは 90 日の経過を待たず
                履歴等から手動で削除することもできます。
              </li>
              <li>
                <strong>プレゼン対策の文字起こし・AI 評価結果・発表後 Q&A</strong>:
                録画動画・発表資料が自動削除された後も、文字起こしテキスト、AI 評価結果、
                および発表後 Q&A 練習の質問・回答・AI フィードバックは、アカウントが有効で
                ある期間、保存します (結果・履歴・学習の振り返りのため)。ユーザーから
                第 9 条に基づく削除請求があった場合は、これらも削除します。
              </li>
              <li>
                <strong>決済情報</strong>: Stripe, Inc. 側で同社のポリシーおよび関連法令
                (税務、会計、不正利用調査等) に従い保存
              </li>
              <li>
                <strong>アクセスログ</strong>: 不具合調査・不正利用調査の目的で取得から
                12 ヶ月程度を目安に保存
              </li>
            </ul>
            <p>
              ユーザーから第 9 条に基づく削除請求があった場合、合理的な期間内に削除を
              行います。ただし、法令上の保管義務がある情報、または不正利用調査のために
              必要な情報については、所定の期間保管することがあります。
            </p>
          </LegalSection>

          <LegalSection number={8} title="安全管理措置">
            <p>
              当サービスは、取得した個人情報の漏えい、滅失、毀損を防止するため、以下の
              措置を講じます。
            </p>
            <ul className="list-disc pl-5 space-y-1">
              <li>通信の暗号化 (HTTPS / TLS)</li>
              <li>
                データベースへのアクセス制御 (Row Level Security による所有者単位の
                データアクセス制限)
              </li>
              <li>
                決済情報のサーバ非保持 (カード情報は Stripe が直接取得・処理)
              </li>
              <li>業務委託先の安全管理水準の継続的な確認</li>
              <li>システムの定期的な保守・更新および脆弱性対応</li>
              <li>運営側担当者へのアクセス権限の最小化</li>
            </ul>
          </LegalSection>

          <LegalSection
            number={9}
            title="ユーザーの権利 (開示・訂正・削除・利用停止)"
          >
            <p>
              ユーザーは、当サービスに対し、ご自身の個人情報について以下の請求を行う
              ことができます。
            </p>
            <ul className="list-disc pl-5 space-y-1">
              <li>取得している情報の開示請求</li>
              <li>内容に誤りがある場合の訂正、追加、削除請求</li>
              <li>個人情報の利用停止または消去の請求</li>
              <li>第三者への提供の停止請求</li>
            </ul>
            <p>
              請求は、第 11 条のお問い合わせ窓口までご連絡ください。本人確認を行ったうえで、
              法令およびシステム上の可能な範囲で合理的な期間内に対応します。請求対応に
              伴い、本サービスの一部機能の利用に制限が生じる場合があります。
            </p>
            <p className="text-xs text-slate-500">
              なお、AI 機能 (Anthropic Claude) に過去送信した内容についてのデータ削除は、
              当サービスのデータベースから削除を行うとともに、委託先事業者の規約および
              技術仕様に従って削除依頼を行います。
            </p>
            <p className="text-xs text-slate-500">
              PASSAI CAREER をログインせずにご利用の場合、入力内容はご利用中のブラウザ内
              にのみ保存されており、当サービスは当該データを保有していません。この場合は、
              各機能の履歴画面から削除いただくか、ブラウザのサイトデータを消去することで
              削除できます。
            </p>
          </LegalSection>

          <LegalSection number={10} title="未成年者の利用">
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-2">
              <p className="text-sm text-amber-900 leading-relaxed">
                PASSAI (大学受験向け) は高校生をはじめとする未成年者の利用が想定されます。
                PASSAI CAREER (新卒就活向け) は主に大学生・大学院生等を対象としますが、
                いずれのサービスも未成年者が利用する可能性があります。
              </p>
            </div>
            <ol className="list-decimal pl-5 space-y-1.5">
              <li>
                未成年者が本サービスを利用する場合は、法定代理人 (保護者) の同意を
                得たうえで利用してください。
              </li>
              <li>
                法定代理人は、本ポリシーおよび利用規約の内容を未成年者に代わって確認し、
                同意したものとみなします。
              </li>
              <li>
                有料プランの契約は、法定代理人の同意を得たうえで未成年者本人または
                法定代理人が行ってください。同意なき契約が判明した場合、当サービスは
                ご連絡のうえ契約を解除することがあります。
              </li>
            </ol>
          </LegalSection>

          <LegalSection number={11} title="お問い合わせ窓口">
            <p>
              本ポリシーおよび個人情報の取扱いに関するお問い合わせ、第 9 条に基づく
              ユーザーの権利行使の請求は、以下までご連絡ください。
            </p>
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-sm">
              <p className="font-semibold text-slate-900 mb-1">
                PASSAI 運営チーム
              </p>
              <p className="text-slate-600 leading-relaxed">
                メールアドレス:{' '}
                <a
                  href={`mailto:${CONTACT_EMAIL}`}
                  className="text-brand-700 hover:underline"
                >
                  {CONTACT_EMAIL}
                </a>
              </p>
            </div>
          </LegalSection>

          <LegalSection number={12} title="本ポリシーの改定">
            <ol className="list-decimal pl-5 space-y-1.5">
              <li>
                当サービスは、法令の改正、サービス内容の変更、業務委託先の変更、その他
                必要に応じて本ポリシーを改定することがあります。
              </li>
              <li>
                本ポリシーを改定する場合、当サービスは改定後の内容および効力発生日を、
                本サービス内またはお知らせページにて告知します。
              </li>
              <li>
                効力発生日以降のユーザーによる本サービスの利用は、改定後の本ポリシーに
                同意したものとみなします。
              </li>
            </ol>
          </LegalSection>
        </div>

        <p className="text-xs text-slate-500 mt-12">以上</p>
      </div>

      <FooterSection />
    </div>
  );
}
