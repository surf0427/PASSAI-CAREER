// localStorage の安全なラッパー。
// SSR（typeof window === 'undefined'）と JSON パースエラーを吸収する。
// すべての storage ファイルはこのヘルパーを通じて localStorage を操作する。

export function safeGetStorage<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const item = localStorage.getItem(key);
    if (!item) return fallback;
    return JSON.parse(item) as T;
  } catch {
    return fallback;
  }
}

export function safeSetStorage<T>(key: string, value: T): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 保存失敗時もアプリは落とさない
  }
}

export function safeRemoveStorage(key: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(key);
  } catch {
    // 削除失敗時もアプリは落とさない
  }
}

/**
 * キーが存在するか（値の中身は問わない）。
 * safeGetStorage は「未保存」と「保存された空値」を fallback で同一視するため、
 * 所有者名前空間の移行（存在するキーだけ移す）ではこちらを使う。
 */
export function safeHasStorage(key: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

/** 生の文字列のまま読む（JSON パースしない）。名前空間移行で値を再解釈しないために使う。 */
export function safeGetRawStorage(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** 生の文字列のまま書く（JSON 化しない）。名前空間移行で値を再解釈しないために使う。 */
export function safeSetRawStorage(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(key, value);
  } catch {
    // 保存失敗時もアプリは落とさない
  }
}
