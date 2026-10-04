import { db, toPlain } from './db';
import { newId } from './id';
import { sessionId } from './session';
import {
  instrumentBlockReason,
  isInstrumentUsable,
  latestCalibration,
} from '../types/instrument';
import {
  RESERVATION_TTL_MS,
  slotsOverlap,
  type InstrumentReservation,
} from '../types/reservation';
import type { TimekeepingTest, TimekeepingTestDraft } from '../types/test';

/** 预约/保存被业务规则拒绝时抛出，消息可直接展示给用户 */
export class BookingError extends Error {}

interface ReserveInput {
  instrumentId: string;
  clockId: string;
  startAt: number;
  endAt: number;
  purpose: string;
}

/**
 * 抢占仪器时段：整段在一个 IndexedDB 可串行化事务里完成。
 * 两个页签同时进来时，IndexedDB 保证只有一个事务先提交，
 * 后到的事务读到已提交的 held 记录，只能冲突失败。
 * 心跳超过 TTL 的 held 视为页签中断，先回收再分配，不会一直占着。
 */
export async function reserveSlot(input: ReserveInput): Promise<InstrumentReservation> {
  const sid = sessionId();
  if (input.endAt <= input.startAt) {
    throw new BookingError('预约结束时间必须晚于开始时间');
  }

  return db.transaction('rw', db.instruments, db.reservations, async () => {
    const now = Date.now();
    const instrument = await db.instruments.get(input.instrumentId);
    const blockReason = instrumentBlockReason(instrument, now);
    if (blockReason) throw new BookingError(blockReason);
    const cert = latestCalibration(instrument!);
    // 检定有效期必须覆盖整个预约时段，时段中途到期的不允许预约
    if (!cert || cert.validUntil < input.endAt) {
      throw new BookingError(
        `仪器检定有效期 ${new Date(cert?.validUntil ?? 0).toLocaleDateString('zh-CN')} 不能覆盖预约结束时间，请先补检`,
      );
    }

    // 回收该仪器上心跳超时的中断预约
    await db.reservations
      .where('instrumentId')
      .equals(input.instrumentId)
      .modify((r) => {
        if (r.status === 'held' && now - r.heartbeatAt >= RESERVATION_TTL_MS) {
          r.status = 'interrupted';
          r.releasedAt = now;
        }
      });

    const held = await db.reservations
      .where('instrumentId')
      .equals(input.instrumentId)
      .filter((r) => r.status === 'held')
      .toArray();
    const clash = held.find((r) => slotsOverlap(input.startAt, input.endAt, r.startAt, r.endAt));
    if (clash) {
      throw new BookingError(
        `该时段已被占用：${new Date(clash.startAt).toLocaleString('zh-CN')} – ${new Date(clash.endAt).toLocaleTimeString('zh-CN')}（藏品测试）`,
      );
    }

    const record: InstrumentReservation = {
      id: newId('rsv'),
      instrumentId: input.instrumentId,
      clockId: input.clockId,
      startAt: input.startAt,
      endAt: input.endAt,
      purpose: input.purpose,
      status: 'held',
      sessionId: sid,
      heartbeatAt: now,
      certVersion: instrument!.certVersion,
      createdAt: now,
    };
    await db.reservations.put(record);
    return record;
  });
}

/** 续约心跳；若预约已不存在/被别人接管则返回 false */
export async function heartbeat(reservationId: string): Promise<boolean> {
  const sid = sessionId();
  let ok = false;
  await db.transaction('rw', db.reservations, async () => {
    const r = await db.reservations.get(reservationId);
    if (!r || r.status !== 'held' || r.sessionId !== sid) return;
    // 自己的心跳不会超时；这里顺手防御：被标记中断则不续约
    r.heartbeatAt = Date.now();
    await db.reservations.put(r);
    ok = true;
  });
  return ok;
}

async function changeReservationStatus(reservationId: string, status: 'released' | 'interrupted'): Promise<boolean> {
  const sid = sessionId();
  let changed = false;
  await db.transaction('rw', db.reservations, async () => {
    const r = await db.reservations.get(reservationId);
    // 仅持有者能主动释放/中断；超时记录留给下一次 reserve 回收
    if (!r || r.status !== 'held' || r.sessionId !== sid) return;
    r.status = status;
    r.releasedAt = Date.now();
    await db.reservations.put(r);
    changed = true;
  });
  return changed;
}

/** 主动取消预约 */
export function releaseReservation(reservationId: string): Promise<boolean> {
  return changeReservationStatus(reservationId, 'released');
}

/** 页签关闭/路由离开：中断预约，立即让出时段 */
export function interruptReservation(reservationId: string): Promise<boolean> {
  return changeReservationStatus(reservationId, 'interrupted');
}

/** 管理员在仪器台账强制释放（含其他页签仍在持有的）预约 */
export async function forceReleaseReservation(reservationId: string): Promise<boolean> {
  let changed = false;
  await db.transaction('rw', db.reservations, async () => {
    const r = await db.reservations.get(reservationId);
    if (!r || r.status !== 'held') return;
    r.status = 'released';
    r.releasedAt = Date.now();
    await db.reservations.put(r);
    changed = true;
  });
  return changed;
}

/** 手动清理所有心跳超时的 held 预约（台账页「回收中断预约」用） */
export async function reclaimStaleReservations(now: number = Date.now()): Promise<number> {
  let reclaimed = 0;
  await db.transaction('rw', db.reservations, async () => {
    await db.reservations
      .where('status')
      .equals('held')
      .modify((r) => {
        if (now - r.heartbeatAt >= RESERVATION_TTL_MS) {
          r.status = 'interrupted';
          r.releasedAt = now;
          reclaimed += 1;
        }
      });
  });
  return reclaimed;
}

/**
 * 凭有效预约保存走时测试，并把预约置为 done。
 * 再次全量校验：预约属于本页签且仍存活、仪器仍在用/未补检/未改有效期、
 * 证书版本一致、时段尚未结束——任一不满足即拒绝，测试不会落库。
 */
export async function completeReservationWithTest(
  draft: TimekeepingTestDraft,
  reservationId: string,
): Promise<TimekeepingTest> {
  const sid = sessionId();
  const plainDraft = toPlain(draft);

  return db.transaction('rw', db.reservations, db.instruments, db.tests, async () => {
    const now = Date.now();
    const r = await db.reservations.get(reservationId);
    if (!r) throw new BookingError('预约不存在或已被取消，请重新预约仪器');
    if (r.status !== 'held') throw new BookingError('预约已结束或被中断，请重新预约仪器');
    if (r.sessionId !== sid) throw new BookingError('该预约属于其他页签，本页不能使用');
    if (now - r.heartbeatAt >= RESERVATION_TTL_MS) {
      throw new BookingError('预约心跳已中断，时段已释放，请重新预约仪器');
    }
    if (now >= r.endAt) throw new BookingError('预约时段已结束，请重新预约');

    const instrument = await db.instruments.get(r.instrumentId);
    if (!isInstrumentUsable(instrument, now)) {
      throw new BookingError(instrumentBlockReason(instrument, now) || '仪器当前不可用');
    }
    if (instrument!.certVersion !== r.certVersion) {
      throw new BookingError('该仪器已补检或调整检定有效期，请按新证书重新预约后复测');
    }
    const cert = latestCalibration(instrument!);
    if (!cert || cert.validUntil < r.endAt) {
      throw new BookingError('仪器检定有效期已不能覆盖该预约时段');
    }
    if (r.clockId !== plainDraft.clockId) {
      throw new BookingError('预约钟表与测试钟表不一致');
    }

    const test: TimekeepingTest = {
      ...plainDraft,
      id: newId('tst'),
      testedAt: now,
      instrumentRef: {
        instrumentId: instrument!.id,
        instrumentNo: instrument!.instrumentNo,
        certVersion: instrument!.certVersion,
        certNo: cert.certNo,
        validUntil: cert.validUntil,
        reservationId: r.id,
      },
    };
    await db.tests.put(toPlain(test));

    r.status = 'done';
    r.releasedAt = now;
    await db.reservations.put(r);

    return test;
  });
}

/** 某台仪器在给定时段是否已被存活的 held 占用（选择时段时的前端预检，最终以 reserve 事务为准） */
export async function findSlotClash(
  instrumentId: string,
  startAt: number,
  endAt: number,
  now: number = Date.now(),
): Promise<InstrumentReservation | undefined> {
  const held = await db.reservations
    .where('instrumentId')
    .equals(instrumentId)
    .filter((r) => r.status === 'held' && now - r.heartbeatAt < RESERVATION_TTL_MS)
    .toArray();
  return held.find((r) => slotsOverlap(startAt, endAt, r.startAt, r.endAt));
}
