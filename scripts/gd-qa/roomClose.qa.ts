// PASSAI 就活版 — GD ルーム終了（cancelRoom）の決定的 QA（登録済み・再実行可能）。
//
// 実行:  npx tsx scripts/gd-qa/roomClose.qa.ts
// 対象:  lib/careerGd/roomCloseCore.ts（cancelRoomCore）— roomClose.ts の中核。
// 目的:  修正2（部屋終了）/ 修正3（リーダー退出）の共通ヘルパーの再実行整合性・冪等性・
//        競合耐性・finished 保護を、fake Supabase adapter で決定的に検証する。
//        DB / env / 外部 AI 非依存。
//
// クローズアウト監査3/4 の中心テスト:
//   ① room=cancelled 更新は成功したが member.left_at 更新が失敗した部分障害
//   ② 再実行で left_at が補正されること（cancelled でも member cleanup を再走する）
//   ③ finished を cancelled で上書きしない・finished の member は触らない
//   ④ close と host-leave（どちらも cancelRoom）が競合しても最終状態が同一

import { cancelRoomCore } from '../../lib/careerGd/roomCloseCore';
import type { SupabaseClient } from '@supabase/supabase-js';

type Row = Record<string, unknown>;

// ── 必要最小限の fake Supabase client（cancelRoomCore が使う chain のみ） ──
type FakeDb = {
  rooms: Row[];
  members: Row[];
  faults: { membersUpdate: number }; // >0 の間、members の update を 1 回ずつ失敗させる
  forceRoomsUpdateEmpty: boolean; // rooms update が 0 行を返す（レース＝他リクエストが先勝ち）を模倣
};

function makeFakeAdmin(db: FakeDb): SupabaseClient {
  class Builder {
    table: 'rooms' | 'members';
    op: 'select' | 'update' = 'select';
    payload: Row | null = null;
    eqs: [string, unknown][] = [];
    inClause: [string, unknown[]] | null = null;
    isNulls: string[] = [];
    returning = false;
    constructor(table: 'rooms' | 'members') {
      this.table = table;
    }
    select() {
      this.returning = true;
      return this;
    }
    update(p: Row) {
      this.op = 'update';
      this.payload = p;
      return this;
    }
    eq(c: string, v: unknown) {
      this.eqs.push([c, v]);
      return this;
    }
    in(c: string, vals: unknown[]) {
      this.inClause = [c, vals];
      return this;
    }
    is(c: string) {
      // 2 引数目（null 値）は runtime で無視して良い（col が left_at IS NULL を表す）。
      this.isNulls.push(c);
      return this;
    }
    private match(row: Row): boolean {
      for (const [c, v] of this.eqs) if (row[c] !== v) return false;
      if (this.inClause) {
        const [c, vals] = this.inClause;
        if (!vals.includes(row[c])) return false;
      }
      for (const c of this.isNulls) if (row[c] != null) return false;
      return true;
    }
    private rows(): Row[] {
      return this.table === 'rooms' ? db.rooms : db.members;
    }
    private exec(): { data: Row[] | null; error: { message: string } | null } {
      const rows = this.rows();
      if (this.op === 'select') {
        return { data: rows.filter((r) => this.match(r)), error: null };
      }
      // update
      if (this.table === 'members' && db.faults.membersUpdate > 0) {
        db.faults.membersUpdate -= 1;
        return { data: null, error: { message: 'injected members update failure' } };
      }
      if (this.table === 'rooms' && db.forceRoomsUpdateEmpty) {
        // レース模倣: 条件付き UPDATE が 0 行。かつ「他リクエストが先に cancelled 化した」状態を作る。
        for (const r of rows.filter((r) => this.eqs.some(([c]) => c === 'id') && r.id === this.eqs.find(([c]) => c === 'id')![1])) {
          r.status = 'cancelled';
        }
        return { data: [], error: null };
      }
      const matched = rows.filter((r) => this.match(r));
      for (const r of matched) Object.assign(r, this.payload);
      return { data: this.returning ? matched.map((r) => ({ ...r })) : null, error: null };
    }
    maybeSingle() {
      const { data, error } = this.exec();
      return Promise.resolve({ data: error ? null : (data?.[0] ?? null), error });
    }
    then(resolve: (v: { data: Row[] | null; error: { message: string } | null }) => void, reject: (e: unknown) => void) {
      try {
        resolve(this.exec());
      } catch (e) {
        reject(e);
      }
    }
  }
  const client = {
    from(table: string) {
      const t = table === 'career_gd_rooms' ? 'rooms' : table === 'career_gd_room_members' ? 'members' : null;
      if (!t) throw new Error(`unexpected table ${table}`);
      return new Builder(t) as unknown as ReturnType<SupabaseClient['from']>;
    },
  };
  return client as unknown as SupabaseClient;
}

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean): void {
  if (cond) pass++;
  else {
    fail++;
    console.error('FAIL:', name);
  }
}
const room = (over: Row = {}): Row => ({ id: 'r1', status: 'waiting', ...over });
const member = (over: Row = {}): Row => ({ id: 'm', room_id: 'r1', is_host: false, left_at: null, ...over });

async function run() {
  // ── T1: waiting → cancelled + 全 active member を退出扱い ──
  {
    const db: FakeDb = {
      rooms: [room()],
      members: [member({ id: 'm1', is_host: true }), member({ id: 'm2' }), member({ id: 'm3' })],
      faults: { membersUpdate: 0 },
      forceRoomsUpdateEmpty: false,
    };
    const r = await cancelRoomCore(makeFakeAdmin(db), 'r1');
    check('T1 ok', r.kind === 'ok');
    check('T1 alreadyClosed false', r.kind === 'ok' && r.alreadyClosed === false);
    check('T1 room cancelled', db.rooms[0].status === 'cancelled');
    check('T1 finished_at set', typeof db.rooms[0].finished_at === 'string');
    check('T1 all members left', db.members.every((m) => m.left_at != null));
  }

  // ── T2（監査3 核心）: 部分障害 → 再実行で left_at 補正 ──
  {
    const db: FakeDb = {
      rooms: [room()],
      members: [member({ id: 'm1', is_host: true }), member({ id: 'm2' })],
      faults: { membersUpdate: 1 }, // 1 回目の members update を失敗させる
      forceRoomsUpdateEmpty: false,
    };
    const admin = makeFakeAdmin(db);
    // 1 回目: room は cancelled になるが member cleanup は失敗（best-effort・ok を返す）。
    const r1 = await cancelRoomCore(admin, 'r1');
    check('T2 call1 ok', r1.kind === 'ok');
    check('T2 call1 room cancelled', db.rooms[0].status === 'cancelled');
    check('T2 call1 members NOT cleaned (partial failure)', db.members.every((m) => m.left_at == null));
    // 2 回目（再試行）: room は既に cancelled でも member cleanup を再走し left_at を補正する。
    const r2 = await cancelRoomCore(admin, 'r1');
    check('T2 call2 ok', r2.kind === 'ok');
    check('T2 call2 alreadyClosed true', r2.kind === 'ok' && r2.alreadyClosed === true);
    check('T2 call2 members corrected on retry', db.members.every((m) => m.left_at != null));
  }

  // ── T3: finished は cancelled で上書きしない・member を触らない ──
  {
    const db: FakeDb = {
      rooms: [room({ status: 'finished', finished_at: '2024-01-01T00:00:00.000Z' })],
      members: [member({ id: 'm1', left_at: null })],
      faults: { membersUpdate: 0 },
      forceRoomsUpdateEmpty: false,
    };
    const r = await cancelRoomCore(makeFakeAdmin(db), 'r1');
    check('T3 ok alreadyClosed', r.kind === 'ok' && r.alreadyClosed === true);
    check('T3 status stays finished', db.rooms[0].status === 'finished');
    check('T3 finished_at unchanged', db.rooms[0].finished_at === '2024-01-01T00:00:00.000Z');
    check('T3 members untouched', db.members[0].left_at == null);
  }

  // ── T4: 既に cancelled でも lingering member を冪等 cleanup ──
  {
    const db: FakeDb = {
      rooms: [room({ status: 'cancelled', finished_at: '2024-02-02T00:00:00.000Z' })],
      members: [member({ id: 'm1', left_at: null }), member({ id: 'm2', left_at: null })],
      faults: { membersUpdate: 0 },
      forceRoomsUpdateEmpty: false,
    };
    const r = await cancelRoomCore(makeFakeAdmin(db), 'r1');
    check('T4 ok alreadyClosed', r.kind === 'ok' && r.alreadyClosed === true);
    check('T4 finished_at not overwritten', db.rooms[0].finished_at === '2024-02-02T00:00:00.000Z');
    check('T4 lingering members cleaned', db.members.every((m) => m.left_at != null));
  }

  // ── T5: 二重終了は冪等（例外・不整合なし） ──
  {
    const db: FakeDb = {
      rooms: [room()],
      members: [member({ id: 'm1', is_host: true })],
      faults: { membersUpdate: 0 },
      forceRoomsUpdateEmpty: false,
    };
    const admin = makeFakeAdmin(db);
    const a = await cancelRoomCore(admin, 'r1');
    const b = await cancelRoomCore(admin, 'r1');
    check('T5 both ok', a.kind === 'ok' && b.kind === 'ok');
    check('T5 second alreadyClosed', b.kind === 'ok' && b.alreadyClosed === true);
    check('T5 final cancelled', db.rooms[0].status === 'cancelled');
  }

  // ── T6: left_at IS NULL の member だけ更新（既退出の時刻を保持） ──
  {
    const db: FakeDb = {
      rooms: [room()],
      members: [member({ id: 'm1', left_at: '2020-01-01T00:00:00.000Z' }), member({ id: 'm2', left_at: null })],
      faults: { membersUpdate: 0 },
      forceRoomsUpdateEmpty: false,
    };
    await cancelRoomCore(makeFakeAdmin(db), 'r1');
    check('T6 already-left timestamp preserved', db.members[0].left_at === '2020-01-01T00:00:00.000Z');
    check('T6 null member now left', db.members[1].left_at != null);
  }

  // ── T7: close と host-leave は同一ヘルパー → 最終状態が一致（競合しても収束） ──
  {
    const mk = (): FakeDb => ({
      rooms: [room({ status: 'active', started_at: 's' })],
      members: [member({ id: 'm1', is_host: true }), member({ id: 'm2' })],
      faults: { membersUpdate: 0 },
      forceRoomsUpdateEmpty: false,
    });
    const dbClose = mk();
    const dbLeave = mk();
    await cancelRoomCore(makeFakeAdmin(dbClose), 'r1'); // close 相当
    await cancelRoomCore(makeFakeAdmin(dbLeave), 'r1'); // host-leave 相当
    const norm = (db: FakeDb) => ({
      status: db.rooms[0].status,
      membersLeft: db.members.every((m) => m.left_at != null),
    });
    check('T7 close/leave converge to same status', norm(dbClose).status === norm(dbLeave).status && norm(dbClose).status === 'cancelled');
    check('T7 both cleaned members', norm(dbClose).membersLeft && norm(dbLeave).membersLeft);
  }

  // ── T8: room が無ければ not_found ──
  {
    const db: FakeDb = { rooms: [], members: [], faults: { membersUpdate: 0 }, forceRoomsUpdateEmpty: false };
    const r = await cancelRoomCore(makeFakeAdmin(db), 'missing');
    check('T8 not_found', r.kind === 'not_found');
  }

  // ── T9（監査3/4 レース）: 条件付き UPDATE が 0 行（他リクエスト先勝ち）でも cleanup が走る ──
  {
    const db: FakeDb = {
      rooms: [room({ status: 'waiting' })],
      members: [member({ id: 'm1', is_host: true }), member({ id: 'm2' })],
      faults: { membersUpdate: 0 },
      forceRoomsUpdateEmpty: true, // update 0 行 + 内部で cancelled 化（他勝者を模倣）
    };
    const r = await cancelRoomCore(makeFakeAdmin(db), 'r1');
    check('T9 ok', r.kind === 'ok');
    check('T9 alreadyClosed (lost race)', r.kind === 'ok' && r.alreadyClosed === true);
    check('T9 room cancelled', db.rooms[0].status === 'cancelled');
    check('T9 members cleaned despite lost race', db.members.every((m) => m.left_at != null));
  }

  console.log(`\nroomClose (cancelRoom) QA: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
