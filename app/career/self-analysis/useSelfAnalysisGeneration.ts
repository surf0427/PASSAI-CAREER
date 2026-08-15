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
import { saveCompletedSelfAnalysis, type SaveRevisionTarget } from './finalizeSummary';
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
  /**
   * 「過去の結果を更新する」のときだけ、更新対象 lineage と備考を返す。
   * 未指定 / null なら新規 lineage として保存する（run 画面の従来挙動）。
   */
  getRevisionTarget?: () => SaveRevisionTarget | null;
  /** 完了後の遷移先。未指定なら結果画面（最新表示）。 */
  resultHref?: string;
  /**
   * pending slot（localStorage）の owner scope に付ける接尾辞。
   *
   * 新規フロー（run）と更新フロー（update）は保存の仕方が違うため、同じ slot を共有すると
   * 「更新の生成中に run 画面へ移動 → run 側の controller が resume → 更新なのに新規として保存」
   * が起こりうる。scope を分けて、各フローが **自分が出した job だけ** を resume するようにする。
   *
   * ★ ownerScope は client 内の slot 名と stale-response guard にのみ使う値で、
   *   server へは送らない（job の所有者は常に認証 cookie 由来）。
   *   run 画面は未指定＝従来と同一 key のまま。
   */
  pendingScope?: string;
}

const DEFAULT_RESULT_HREF = '/career/self-analysis/result';

export function useSelfAnalysisGeneration({
  userId,
  getRequestBody,
  getTurnCount,
  getRevisionTarget,
  resultHref = DEFAULT_RESULT_HREF,
  pendingScope = '',
}: UseSelfAnalysisGenerationArgs) {
  const router = useRouter();
  const [view, setView] = useState<GenerationView>(IDLE_VIEW);

  const controllerRef = useRef<SelfAnalysisGenerationController | null>(null);
  const userIdRef = useRef(userId);
  const getBodyRef = useRef(getRequestBody);
  const getTurnRef = useRef(getTurnCount);
  const getRevisionRef = useRef(getRevisionTarget);
  const routerRef = useRef(router);
  const resultHrefRef = useRef(resultHref);
  const pendingScopeRef = useRef(pendingScope);

  // 「常に最新の props を読む」ための ref 同期。**render 中には書かない**
  // （react-hooks/refs: render 中の ref 書込みは再描画整合性を壊しうる）。
  // controller の callback（timer / fetch 完了 / storage event / event handler）は
  // すべて commit 後に走るため、commit ごとに同期すれば従来と同じ最新値を読む。
  useEffect(() => {
    userIdRef.current = userId;
    getBodyRef.current = getRequestBody;
    getTurnRef.current = getTurnCount;
    getRevisionRef.current = getRevisionTarget;
    routerRef.current = router;
    resultHrefRef.current = resultHref;
    pendingScopeRef.current = pendingScope;
  });

  // mount: controller 生成 → pending から resume → multi-tab listener。unmount: dispose。
  //   ★ controller の生成を render 中ではなく effect 内で行う。render 中に ref を読み書きせず、
  //     Date.now() 等の不純呼び出しも render phase に置かない（react-hooks/purity）。
  //     effect は client でのみ走るため、従来の `typeof window !== 'undefined'` 判定は不要。
  //   ★ cleanup で dispose し ref を空に戻すので、再 mount では必ず新しい controller を作る
  //     （dispose 済み controller が再利用されて polling が無言で止まることを防ぐ）。
  useEffect(() => {
    // pending slot / stale-response guard 用の client-local scope。
    // suffix 未指定（run 画面）では userId そのままで、従来と同じ key になる。
    const ownerScope = (): string | null => {
      const uid = userIdRef.current;
      if (!uid) return null;
      return pendingScopeRef.current ? `${uid}${pendingScopeRef.current}` : uid;
    };

    const c = new SelfAnalysisGenerationController({
      getOwnerScope: ownerScope,
      buildRequestBody: () => getBodyRef.current(),
      postGenerate: (body) => httpPost('/api/career/self-analysis', body),
      getStatus: (jobId) =>
        httpGet(`/api/career/self-analysis/job?jobId=${encodeURIComponent(jobId)}`),
      finalize: async ({ result }) =>
        !!saveCompletedSelfAnalysis({
          result: result as CareerSelfAnalysisResult,
          userId: userIdRef.current,
          turnCount: getTurnRef.current(),
          revision: getRevisionRef.current?.() ?? null,
        }),
      navigate: () => routerRef.current.push(resultHrefRef.current),
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
      const owner = ownerScope();
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
