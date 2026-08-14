/*
 * scripts/career-consent-capture-qa.ts
 *
 * PASSAI CAREER — NEXT-7: Consent capture surface QA（dev-only・DI fake・実 Supabase 非接続）。
 *
 * 何を守るか:
 *   [1] gate は **fail-closed**: flag / 法務承認 / readiness のどれか 1 つでも欠ければ閉じる。
 *   [2] 全 decision が揃ったときだけ scope が開く。Layer 5 scope は Layer 5 decision を要求する。
 *   [3] scope allowlist: gate が閉じていれば isScopeCapturable は常に false（default deny）。
 *   [4] service: repository 未接続（現状）→ unavailable。ledger へ 1 件も書かない。
 *   [5] service: repository があれば grant/withdraw を append し receipt を返す。
 *   [6] service: 送信内容に IP / UA / free text / client timestamp / serverSequence を含めない。
 *   [7] 静的 guard: route が server auth を使い、service role / request body userId を使わない。
 *   [8] 静的 guard: route / gate / service が Layer 4 / Layer 5 の production consumer を import しない。
 *   [9] 静的 guard: UI カードが同意文言（法的 notice 本文）を hard-code しない。
 *   [10] 静的 guard: capture 経路が Event Log / Event Signal / matching に触れない。
 *
 * 使い方: npx tsx --tsconfig tsconfig.realtime-test.json scripts/career-consent-capture-qa.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONSENT_CAPTURE_SCOPES,
  evaluateConsentCaptureGate,
  isScopeCapturable,
  requiredDecisionsForScope,
} from '@/lib/careerConsent/captureGate';
import {
  captureConsent,
  readConsentReceipt,
  type ConsentCaptureDeps,
  type ConsentCaptureRepository,
} from '@/lib/careerConsent/captureService';
import {
  LAYER4_REQUIRED_DECISIONS,
  LAYER5_REQUIRED_DECISIONS,
  READINESS_DECISIONS,
  type ReadinessConfig,
  type ReadinessDecisionKey,
} from '@/lib/careerDataSpinePolicy/readiness';
import type { ConsentLedgerEvent } from '@/types/careerConsent';

const ROOT = process.cwd();
let failures = 0;
const check = (ok: boolean, name: string, detail?: string) => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};

const UID = '11111111-1111-1111-1111-111111111111';

function readiness(keys: readonly ReadinessDecisionKey[]): ReadinessConfig {
  const cfg: ReadinessConfig = {};
  for (const k of keys) cfg[k] = true;
  return cfg;
}
const ALL_READY = readiness(READINESS_DECISIONS);

type AppendCall = Parameters<ConsentCaptureRepository['appendCapture']>[0];

function fakeRepo(calls: AppendCall[], events: ConsentLedgerEvent[] = []): ConsentCaptureRepository {
  return {
    async listForSubject() { return events; },
    async appendCapture(input) { calls.push(input); return { ok: true }; },
  };
}

async function main() {
  console.log('[1] gate は fail-closed');
  {
    check(!evaluateConsentCaptureGate(undefined, undefined, undefined).enabled, '全部未設定 → closed');
    const noFlag = evaluateConsentCaptureGate(undefined, 'true', ALL_READY);
    check(!noFlag.enabled && !noFlag.enabled && noFlag.reason === 'flag_off', 'flag 未設定 → flag_off');
    const noLegal = evaluateConsentCaptureGate('true', undefined, ALL_READY);
    check(!noLegal.enabled && noLegal.reason === 'legal_not_approved', '法務未承認 → legal_not_approved');
    const noReady = evaluateConsentCaptureGate('true', 'true', {});
    check(!noReady.enabled && noReady.reason === 'readiness_incomplete', 'readiness 未充足 → readiness_incomplete');
    // 部分 readiness（Layer 4 のうち 1 つ欠け）も閉じる。
    const partial = readiness(LAYER4_REQUIRED_DECISIONS.slice(1));
    check(!evaluateConsentCaptureGate('true', 'true', partial).enabled, '部分 readiness → closed');
    for (const raw of ['TRUE ', '1', 'yes']) {
      check(evaluateConsentCaptureGate(raw, raw, ALL_READY).enabled, `flag 値 "${raw.trim()}" を有効と解釈`);
    }
    check(!evaluateConsentCaptureGate('on', 'on', ALL_READY).enabled, "'on' は有効化しない（allowlist 厳密）");
  }

  console.log('[2] Layer 別 readiness の要求');
  {
    const l4Only = evaluateConsentCaptureGate('true', 'true', readiness(LAYER4_REQUIRED_DECISIONS));
    check(l4Only.enabled, 'Layer 4 decision 充足 → 一部 scope が開く');
    if (l4Only.enabled) {
      check(!l4Only.scopes.includes('externally_shared_insight'), 'Layer 5 scope は開かない（externally_shared_insight）');
      check(!l4Only.scopes.includes('company_knowledge_contribution'), 'Layer 5 scope は開かない（company_knowledge_contribution）');
      check(l4Only.scopes.includes('internal_aggregated_analytics'), 'Layer 4 scope は開く');
    }
    const all = evaluateConsentCaptureGate('true', 'true', ALL_READY);
    check(all.enabled && all.scopes.length === CONSENT_CAPTURE_SCOPES.length, '全 decision 充足 → 全 capture scope');
    check(
      requiredDecisionsForScope('company_knowledge_contribution') === LAYER5_REQUIRED_DECISIONS,
      'company_knowledge_contribution は Layer 5 decision を要求',
    );
    check(
      !(CONSENT_CAPTURE_SCOPES as readonly string[]).includes('personal_service_processing'),
      '通常サービス処理 scope は capture 対象に含めない',
    );
  }

  console.log('[3] scope allowlist は default deny');
  {
    const closed = evaluateConsentCaptureGate(undefined, undefined, ALL_READY);
    for (const scope of [...CONSENT_CAPTURE_SCOPES, 'personal_service_processing', 'bogus', '', null, 42]) {
      check(!isScopeCapturable(closed, scope), `closed gate では "${String(scope)}" を拒否`);
    }
    const open = evaluateConsentCaptureGate('true', 'true', ALL_READY);
    check(!isScopeCapturable(open, 'bogus'), 'open gate でも未知 scope は拒否');
    check(!isScopeCapturable(open, 'personal_service_processing'), 'open gate でも capture 対象外 scope は拒否');
  }

  console.log('[4] repository 未接続（現状の production 既定）→ 1 件も書かない');
  {
    const deps: ConsentCaptureDeps = { repository: null, now: () => 0 };
    const read = await readConsentReceipt(UID, deps);
    check(read.status === 'unavailable', 'read → unavailable');
    const write = await captureConsent(
      UID,
      { scope: 'internal_aggregated_analytics', action: 'grant', sourceSurface: 's' },
      deps,
    );
    check(write.status === 'unavailable', 'write → unavailable（append されない）');
  }

  console.log('[5] repository があれば grant / withdraw を append し receipt を返す');
  {
    const calls: AppendCall[] = [];
    const deps: ConsentCaptureDeps = { repository: fakeRepo(calls), now: () => Date.parse('2026-08-14T00:00:00Z') };
    const grant = await captureConsent(
      UID,
      { scope: 'internal_aggregated_analytics', action: 'grant', sourceSurface: 'card' },
      deps,
    );
    check(grant.status === 'ok', 'grant → ok');
    check(calls.length === 1 && calls[0].action === 'grant', 'append 1 回・action=grant');
    check(typeof calls[0].consentVersion === 'number' && calls[0].consentVersion !== null, 'grant は manifest の version を持つ');
    check(typeof calls[0].policyDigest === 'string', 'grant は policy digest を参照する（本文を複製しない）');

    const withdraw = await captureConsent(
      UID,
      { scope: 'internal_aggregated_analytics', action: 'withdraw', sourceSurface: 'card' },
      deps,
    );
    check(withdraw.status === 'ok', 'withdraw → ok');
    check(calls[1].consentVersion === null && calls[1].noticeVersion === null, 'withdraw は version を持たない');
  }

  console.log('[6] append 内容に evidence field / client 権威値を含めない');
  {
    const calls: AppendCall[] = [];
    const deps: ConsentCaptureDeps = { repository: fakeRepo(calls), now: () => 0 };
    await captureConsent(UID, { scope: 'ai_context_aggregated_insight', action: 'grant', sourceSurface: 'card' }, deps);
    const keys = Object.keys(calls[0]).sort();
    check(
      keys.join(',') === 'action,consentVersion,noticeVersion,policyDigest,scope,sourceSurface,subjectUserId',
      `append key = ${keys.join(',')}`,
    );
    for (const forbidden of ['ip', 'ipAddress', 'userAgent', 'deviceFingerprint', 'reason', 'note', 'email', 'serverSequence', 'recordedAt', 'effectiveAt']) {
      check(!keys.includes(forbidden), `append に "${forbidden}" を含めない`);
    }
  }

  console.log('[7] 静的 guard: route の認証・権限境界');
  {
    const src = readFileSync(join(ROOT, 'app/api/career/consent/route.ts'), 'utf8');
    const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    check(/auth\.getUser\(\)/.test(code), 'subject は server auth から取得する');
    check(!/b\.userId|body\.userId|subjectUserId:\s*b\./.test(code), 'request body の userId を使わない');
    check(!/serviceRole|SERVICE_ROLE/.test(code), 'service role を使わない（D-L7）');
    check(/is_anonymous/.test(code), 'anonymous を除外する');
    check(/loadConsentCaptureGate\(\)/.test(code), 'gate を必ず評価する');
    check(/repository:\s*null/.test(code), 'production repository は未接続（fail-closed）');
    check(!/headers\(\)|user-agent|x-forwarded-for/i.test(code), 'IP / UA を読まない');
  }

  console.log('[8] 静的 guard: Layer 4 / Layer 5 production consumer 非 import');
  {
    for (const rel of [
      'app/api/career/consent/route.ts',
      'lib/careerConsent/captureGate.ts',
      'lib/careerConsent/captureGate.server.ts',
      'lib/careerConsent/captureService.ts',
    ]) {
      const code = readFileSync(join(ROOT, rel), 'utf8')
        .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      check(!/careerContextLoaders\/(aggregatedInsight|companyKnowledge)/.test(code), `${rel}: L4/L5 loader を import しない`);
      check(!/careerAggregate\/(pipeline|shadowDispatcher|supabaseReadRepository)/.test(code), `${rel}: L4 production pipeline を import しない`);
      check(!/careerCompanyKnowledge\/(projection|supabaseReadRepository)/.test(code), `${rel}: L5 shared read を import しない`);
    }
  }

  console.log('[9] 静的 guard: UI が法的 notice 本文を hard-code しない');
  {
    const src = readFileSync(join(ROOT, 'app/career/mypage/CareerConsentCard.tsx'), 'utf8');
    check(/return null/.test(src), 'gate 閉時は null を返す（現行 UI 不変）');
    check(!/利用規約|プライバシーポリシー全文|第\d+条/.test(src), '法的文言本文を持たない');
    check(/JSON.stringify\(\{ scope, action \}\)/.test(src), '送信するのは scope と action のみ');
    check(!/userAgent|navigator\.|ipAddress/.test(src), '端末情報を送らない');
  }

  console.log('[10] 静的 guard: capture 経路が Event Log / matching に触れない');
  {
    for (const rel of [
      'app/api/career/consent/route.ts',
      'lib/careerConsent/captureService.ts',
      'app/career/mypage/CareerConsentCard.tsx',
    ]) {
      const code = readFileSync(join(ROOT, rel), 'utf8')
        .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      check(!/recordCareerEvent|careerEvents|EventSignal/.test(code), `${rel}: Event Log / Signal に触れない（D-L3）`);
      check(!/careerMatching|scoreMatch/.test(code), `${rel}: matching に接続しない（D-L4）`);
    }
  }

  console.log('');
  console.log(failures === 0 ? 'career-consent-capture-qa: ALL PASS' : `career-consent-capture-qa: ${failures} FAIL`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
