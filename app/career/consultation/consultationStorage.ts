// PASSAI 就活版 — 就活相談AI のスレッド storage 層。
//
// 受験版 lib/tutorChatStorage.ts の thread 管理を踏襲しつつ、就活版専用キーで分離する。
//   - 受験版キー: 'tutorChatThreads'
//   - 就活版キー: 'careerConsultationLogs'
// Auth / Stripe / Supabase / DB には一切触らない（匿名 localStorage のみ）。

import { safeGetStorage, safeSetStorage } from '@/lib/storage/safeStorage';
import type {
  CareerConsultationThread,
  CareerConsultationMessage,
} from '@/types/careerConsultation';
// 所有者名前空間（account switch 隔離）。guest は従来キーのまま、member は所有者 suffix 付き。
// ★ 定数ではなく **呼び出しのたびに** 解決する（module 読み込み時に固定すると、
//   後からログイン/ログアウトしても古い名前空間を掴み続けるため）。
import { careerStorageKey } from '@/lib/careerStorage/owner';

function STORAGE_KEY(): string {
  return careerStorageKey('careerConsultationLogs');
}
const MAX_THREADS = 50;
const MAX_MESSAGES_PER_THREAD = 200;

export function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // fall through
  }
  return `cc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// 最初のユーザー発言からスレッドタイトルを生成する（AI は使わない）。
export function deriveThreadTitle(firstUserMessage: string): string {
  const trimmed = firstUserMessage.trim();
  if (trimmed === '') return '新しい相談';
  const normalized = trimmed.replace(/\s+/g, ' ');
  return normalized.length <= 30 ? normalized : `${normalized.slice(0, 28)}…`;
}

export function loadConsultationThreads(): CareerConsultationThread[] {
  const raw = safeGetStorage<CareerConsultationThread[] | null>(STORAGE_KEY(), null);
  return Array.isArray(raw) ? raw : [];
}

// 上限を守りつつ、更新日時の新しい順に並べて保存する。
export function saveConsultationThreads(threads: CareerConsultationThread[]): void {
  const trimmed = threads
    .map((t) => ({
      ...t,
      messages:
        t.messages.length > MAX_MESSAGES_PER_THREAD
          ? t.messages.slice(-MAX_MESSAGES_PER_THREAD)
          : t.messages,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_THREADS);
  safeSetStorage(STORAGE_KEY(), trimmed);
}

export function createThread(): CareerConsultationThread {
  const now = new Date().toISOString();
  return {
    id: newId(),
    title: '新しい相談',
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}

// 指定スレッドにメッセージを追記した新しいスレッド配列を返す（純粋）。
export function appendMessageToThread(
  threads: CareerConsultationThread[],
  threadId: string,
  message: Omit<CareerConsultationMessage, 'id' | 'createdAt'>,
): CareerConsultationThread[] {
  const now = new Date().toISOString();
  const newMessage: CareerConsultationMessage = {
    id: newId(),
    createdAt: now,
    ...message,
  };
  return threads.map((t) => {
    if (t.id !== threadId) return t;
    const shouldUpdateTitle =
      t.title === '新しい相談' &&
      message.role === 'user' &&
      t.messages.every((m) => m.role !== 'user');
    return {
      ...t,
      messages: [...t.messages, newMessage],
      title: shouldUpdateTitle ? deriveThreadTitle(message.content) : t.title,
      updatedAt: now,
    };
  });
}

export function deleteThread(
  threads: CareerConsultationThread[],
  threadId: string,
): CareerConsultationThread[] {
  return threads.filter((t) => t.id !== threadId);
}
