'use client';

// 自己分析まとめ生成 — member job controller を React へ配線する hook（Step3）。
//
// controller（lib/careerSelfAnalysis/clientJob/controller）へ実 deps を注入し、
// mount で resume、storage event で multi-tab、unmount で dispose、logout で cleanup する。
// 生成ロジックは controller 側（pure・DI・QA 済み）にあり、本 hook は配線のみ。

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { SelfAnalysisGenerationController } from '@/lib/careerSelfAnalysis/clientJob/controller';
import { keyForOwner } from '@/lib/careerSelfAnalysis/clientJob/pendingStore';
import type {
  GenerationView,
  HttpResult,
  SelfAnalysisRequestBody,
} from '@/lib/careerSelfAnalysis/clientJob/types';
import {
  SELF_ANALYSIS_OUTPUT_SCHEMA_REVISION,
  SELF_ANALYSIS_PROMPT_REVISION,
} from '@/lib/careerGenerationJob/constants';
import { saveCompletedSelfAnalysis } from './finalizeSummary';
import type { CareerSelfAnalysisResult } from '@/types/careerSelfAnalysis';

const IDLE_VIEW: GenerationView = {
  state: 'idle',
  canRetry: false,
  canRecheck: false,
  errorCode: null,
};

async function httpPost(url: string, body: unknown): Promise<HttpResult> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const parsed = await res.json().catch(() => null);
    return { kind: 'ok', status: res.status, body: parsed };
  } catch {
    return { kind: 'transport_error' };
  }
}

async function httpGet(url: string): Promise<HttpResult> {
  try {
    const res = await fetch(url);
    const parsed = await res.json().catch(() => null);
    return { kind: 'ok', status: res.status, body: parsed };
  } catch {
    return { kind: 'transport_error' };
  }
}

export interface UseSelfAnalysisGenerationArgs {
  userId: string | null;
  /** 現在の入力から request body を組む（材料が無ければ null）。 */
  getRequestBody: () => SelfAnalysisRequestBody | null;
  /** event 記録用の深掘り回数。 */
  getTurnCount: () => number;
}

export function useSelfAnalysisGeneration({
  userId,
  getRequestBody,
  getTurnCount,
}: UseSelfAnalysisGenerationArgs) {
  const router = useRouter();
  const [view, setView] = useState<GenerationView>(IDLE_VIEW);

  const controllerRef = useRef<SelfAnalysisGenerationController | null>(null);
  const userIdRef = useRef(userId);
  const getBodyRef = useRef(getRequestBody);
  const getTurnRef = useRef(getTurnCount);
  const routerRef = useRef(router);

  // 「常に最新の props を読む」ための ref 同期。**render 中には書かない**
  // （react-hooks/refs: render 中の ref 書込みは再描画整合性を壊しうる）。
  // controller の callback（timer / fetch 完了 / storage event / event handler）は
  // すべて commit 後に走るため、commit ごとに同期すれば従来と同じ最新値を読む。
  useEffect(() => {
    userIdRef.current = userId;
    getBodyRef.current = getRequestBody;
    getTurnRef.current = getTurnCount;
    routerRef.current = router;
  });

  // mount: controller 生成 → pending から resume → multi-tab listener。unmount: dispose。
  //   ★ controller の生成を render 中ではなく effect 内で行う。render 中に ref を読み書きせず、
  //     Date.now() 等の不純呼び出しも render phase に置かない（react-hooks/purity）。
  //     effect は client でのみ走るため、従来の `typeof window !== 'undefined'` 判定は不要。
  //   ★ cleanup で dispose し ref を空に戻すので、再 mount では必ず新しい controller を作る
  //     （dispose 済み controller が再利用されて polling が無言で止まることを防ぐ）。
  useEffect(() => {
    const c = new SelfAnalysisGenerationController({
      getOwnerScope: () => userIdRef.current,
      buildRequestBody: () => getBodyRef.current(),
      postGenerate: (body) => httpPost('/api/career/self-analysis', body),
      getStatus: (jobId) =>
        httpGet(`/api/career/self-analysis/job?jobId=${encodeURIComponent(jobId)}`),
      finalize: async ({ result }) =>
        saveCompletedSelfAnalysis({
          result: result as CareerSelfAnalysisResult,
          userId: userIdRef.current,
          turnCount: getTurnRef.current(),
        }),
      navigate: () => routerRef.current.push('/career/self-analysis/result'),
      storage: window.localStorage,
      now: () => Date.now(),
      schedule: (ms, cb) => window.setTimeout(cb, ms),
      cancel: (h) => window.clearTimeout(h as number),
      onChange: (v) => setView(v),
      promptRevision: SELF_ANALYSIS_PROMPT_REVISION,
      outputSchemaRevision: SELF_ANALYSIS_OUTPUT_SCHEMA_REVISION,
      validateResult: (r) => !!r && typeof r === 'object',
    });
    controllerRef.current = c;
    c.resumeFromMount();

    const onStorage = (e: StorageEvent) => {
      const owner = userIdRef.current;
      if (!owner) return;
      if (e.key === keyForOwner(owner)) c.handleExternalPendingChange(e.newValue);
    };
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('storage', onStorage);
      c.dispose();
      if (controllerRef.current === c) controllerRef.current = null;
    };
  }, []);

  // logout（member → null）: polling 停止 + pending 削除。
  const prevUserRef = useRef(userId);
  useEffect(() => {
    const c = controllerRef.current;
    if (c && prevUserRef.current && !userId) c.onLogout();
    prevUserRef.current = userId;
  }, [userId]);

  const start = useCallback(() => controllerRef.current?.submit(), []);
  const retry = useCallback(() => controllerRef.current?.retry(), []);
  const recheck = useCallback(() => controllerRef.current?.recheck(), []);

  return { view, start, retry, recheck };
}
