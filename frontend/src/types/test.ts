import type { CalibrationInstrument } from './instrument';

/** 测试方位 */
export type TestPosition = '面上' | '面下' | '12上' | '6上';

export const TEST_POSITIONS: TestPosition[] = ['面上', '面下', '12上', '6上'];

/** 单方位读数 */
export interface PositionReading {
  position: TestPosition;
  /** 日差 s/d */
  rate: number;
  /** 摆幅 ° */
  amplitude: number;
  /** 偏振 ms */
  beatError: number;
}

/** 测试保存时随带的仪器检定凭证快照 */
export interface TestInstrumentRef {
  instrumentId: string;
  /** 仪器资产编号冗余，便于仪器删除后展示 */
  instrumentNo: string;
  /** 保存时的证书版本 */
  certVersion: number;
  /** 保存时引用的检定证书编号 */
  certNo: string;
  /** 保存时的检定有效期 */
  validUntil: number;
  /** 对应预约记录 */
  reservationId: string;
}

/** 走时测试记录 */
export interface TimekeepingTest {
  id: string;
  clockId: string;
  testedAt: number;
  /** 摆幅 ° */
  amplitude: number;
  /** 偏振 ms */
  beatError: number;
  /** 日差 s/d */
  rate: number;
  positions: PositionReading[];
  /** 动力储备 h */
  powerReserve: number;
  conclusion: string;
  /**
   * 测试时使用的校表仪凭证。
   * 旧测试没有该字段，一律列入「待补证」，不沿用原合格结论。
   */
  instrumentRef?: TestInstrumentRef;
}

export type TimekeepingTestDraft = Omit<TimekeepingTest, 'id'>;

/** 测试凭证状态 */
export type TestEvidence = 'valid' | 'invalid' | 'pending-evidence';

/** 走时合格判定 */
export function judgeTest(rate: number, beatError: number, amplitude: number): string {
  if (Math.abs(rate) <= 10 && beatError <= 0.8 && amplitude >= 250) return '合格';
  if (Math.abs(rate) <= 30 && beatError <= 1.2) return '可用（需再调）';
  return '不合格';
}

/**
 * 判定测试凭证状态：
 * - pending-evidence：旧测试无仪器记录，或关联仪器已删除，须复测补证；
 * - invalid：仪器停用、补检、改有效期（证书版本变化），测试立即失效；
 * - valid：仪器在用且证书版本未变（测试时刻仪器是否在检定有效期内，保存预约时已强制校验）。
 */
export function testEvidenceOf(
  test: TimekeepingTest,
  instruments: CalibrationInstrument[],
): TestEvidence {
  const ref = test.instrumentRef;
  if (!ref) return 'pending-evidence';
  const instrument = instruments.find((it) => it.id === ref.instrumentId);
  if (!instrument) return 'pending-evidence';
  if (instrument.status === '停用') return 'invalid';
  if (instrument.certVersion !== ref.certVersion) return 'invalid';
  const cert = instrument.calibrations.find((c) => c.certNo === ref.certNo);
  if (!cert) return 'invalid';
  return 'valid';
}

/** 凭证有效且走时判定合格，才能支撑钟表完工 */
export function isPassingTest(test: TimekeepingTest, evidence: TestEvidence): boolean {
  if (evidence !== 'valid') return false;
  const judged = judgeTest(test.rate, test.beatError, test.amplitude);
  return (test.conclusion || judged) === '合格';
}

export const TEST_EVIDENCE_LABEL: Record<TestEvidence, string> = {
  valid: '凭证有效',
  invalid: '已失效',
  'pending-evidence': '待补证',
};
