import { defineStore } from 'pinia';
import { db, toPlain } from '../utils/db';
import { newId } from '../utils/id';
import {
  isInstrumentUsable,
  type CalibrationInstrument,
  type CalibrationRecord,
  type InstrumentDraft,
} from '../types/instrument';
import type { InstrumentReservation } from '../types/reservation';

interface InstrumentState {
  items: CalibrationInstrument[];
  reservations: InstrumentReservation[];
  loaded: boolean;
}

export const useInstrumentStore = defineStore('instrument', {
  state: (): InstrumentState => ({ items: [], reservations: [], loaded: false }),
  getters: {
    byId: (state) => (id: string) => state.items.find((it) => it.id === id),
    /** 当前可预约（在用且检定在有效期内）的仪器 */
    usable(state): CalibrationInstrument[] {
      const now = Date.now();
      return state.items.filter((it) => isInstrumentUsable(it, now));
    },
    reservationsByInstrument: (state) => (instrumentId: string) =>
      state.reservations
        .filter((r) => r.instrumentId === instrumentId)
        .sort((a, b) => b.startAt - a.startAt),
  },
  actions: {
    async load() {
      this.items = await db.instruments.orderBy('createdAt').reverse().toArray();
      this.reservations = await db.reservations.orderBy('startAt').reverse().toArray();
      this.loaded = true;
    },
    /** load 的语义化别名：他页签改动后静默刷新 */
    async refresh() {
      await this.load();
    },
    async add(draft: InstrumentDraft) {
      const record: CalibrationInstrument = {
        ...toPlain(draft),
        id: newId('ins'),
        certVersion: 1,
        createdAt: Date.now(),
      };
      await db.instruments.put(toPlain(record));
      this.items = [record, ...this.items];
      return record;
    },
    async updateBase(id: string, patch: Partial<Pick<CalibrationInstrument, 'instrumentNo' | 'name' | 'maker' | 'location'>>) {
      const plain = toPlain(patch);
      await db.instruments.update(id, plain);
      this.items = this.items.map((it) => (it.id === id ? { ...it, ...plain } : it));
    },
    /** 停用/启用：停用即 bump 证书版本，引用该仪器的测试立即失效 */
    async setStatus(id: string, status: CalibrationInstrument['status']) {
      const current = this.items.find((it) => it.id === id);
      if (!current) return;
      const patch: Partial<CalibrationInstrument> = { status };
      if (status === '停用' && current.status !== '停用') patch.certVersion = current.certVersion + 1;
      const plain = toPlain(patch);
      await db.instruments.update(id, plain);
      this.items = this.items.map((it) => (it.id === id ? { ...it, ...plain } : it));
    },
    /** 补检：追加检定记录并 bump 证书版本，旧测试立即失效，须复测 */
    async addCalibration(id: string, record: CalibrationRecord) {
      const current = this.items.find((it) => it.id === id);
      if (!current) return;
      const next: CalibrationInstrument = {
        ...current,
        calibrations: [...current.calibrations, toPlain(record)],
        certVersion: current.certVersion + 1,
      };
      await db.instruments.put(toPlain(next));
      this.items = this.items.map((it) => (it.id === id ? next : it));
    },
    /** 修改某次检定的有效期：bump 证书版本，引用该仪器的测试立即失效 */
    async updateValidity(id: string, certNo: string, validUntil: number) {
      const current = this.items.find((it) => it.id === id);
      if (!current) return;
      const calibrations = current.calibrations.map((c) =>
        c.certNo === certNo ? { ...c, validUntil } : c,
      );
      const next: CalibrationInstrument = {
        ...current,
        calibrations,
        certVersion: current.certVersion + 1,
      };
      await db.instruments.put(toPlain(next));
      this.items = this.items.map((it) => (it.id === id ? next : it));
    },
  },
});
