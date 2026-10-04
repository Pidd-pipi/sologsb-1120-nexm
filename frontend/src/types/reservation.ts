/** 仪器时段预约状态 */
export type ReservationStatus = 'held' | 'released' | 'interrupted' | 'done';

/** 校表仪时段预约（同一台仪器同一时段全局只能有一条 held） */
export interface InstrumentReservation {
  id: string;
  instrumentId: string;
  clockId: string;
  /** 预约起始（半开区间 [start, end)） */
  startAt: number;
  /** 预约结束 */
  endAt: number;
  purpose: string;
  status: ReservationStatus;
  /** 占用该预约的浏览器页签会话 */
  sessionId: string;
  /** 最近一次心跳时间；超过 TTL 未续约视为中断，可被他人接管 */
  heartbeatAt: number;
  /** 预约时的仪器证书版本 */
  certVersion: number;
  createdAt: number;
  releasedAt?: number;
}

/** 心跳超时时间：页签崩溃/关闭后预约最多被多占 15s */
export const RESERVATION_TTL_MS = 15_000;
/** 存活页签每 5s 续约一次 */
export const RESERVATION_HEARTBEAT_MS = 5_000;

/** 两个时段是否重叠（半开区间，首尾相接不算冲突） */
export function slotsOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** 预约是否仍被有效持有（心跳未超时） */
export function isReservationAlive(r: Pick<InstrumentReservation, 'status' | 'heartbeatAt'>, now: number = Date.now()): boolean {
  return r.status === 'held' && now - r.heartbeatAt < RESERVATION_TTL_MS;
}
