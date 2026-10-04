/** 校表仪状态 */
export type InstrumentStatus = '在用' | '停用';

/** 检定（过检）记录 */
export interface CalibrationRecord {
  /** 检定时间 */
  calibratedAt: number;
  /** 检定证书编号 */
  certNo: string;
  /** 检定机构 */
  certOrg: string;
  /** 检定有效期截止 */
  validUntil: number;
  /** 结论 */
  result: string;
}

/** 校表仪（仪器台账） */
export interface CalibrationInstrument {
  id: string;
  /** 资产编号 */
  instrumentNo: string;
  /** 仪器名称/型号 */
  name: string;
  /** 厂家 */
  maker: string;
  status: InstrumentStatus;
  /** 存放位置 */
  location: string;
  /** 检定历史，最近一次在末尾，有效期以末条为准 */
  calibrations: CalibrationRecord[];
  /**
   * 证书版本：停用、补检、改有效期都会 +1。
   * 测试记录保存时的版本与当前版本不一致即视为失效。
   */
  certVersion: number;
  createdAt: number;
}

export type InstrumentDraft = Omit<CalibrationInstrument, 'id' | 'createdAt' | 'certVersion'>;

/** 仪器是否处于可预约状态：在用且最近一次检定仍在有效期内 */
export function isInstrumentUsable(instrument: CalibrationInstrument | undefined, at: number = Date.now()): boolean {
  if (!instrument || instrument.status === '停用') return false;
  const latest = instrument.calibrations[instrument.calibrations.length - 1];
  return !!latest && latest.validUntil > at;
}

/** 仪器不可用的原因（可预约检查用） */
export function instrumentBlockReason(instrument: CalibrationInstrument | undefined, at: number = Date.now()): string {
  if (!instrument) return '仪器不存在或已删除';
  if (instrument.status === '停用') return `仪器「${instrument.instrumentNo} ${instrument.name}」已停用`;
  const latest = instrument.calibrations[instrument.calibrations.length - 1];
  if (!latest) return `仪器「${instrument.instrumentNo} ${instrument.name}」尚无检定记录`;
  if (latest.validUntil <= at) {
    return `仪器「${instrument.instrumentNo} ${instrument.name}」检定已于 ${new Date(latest.validUntil).toLocaleDateString('zh-CN')} 到期`;
  }
  return '';
}

/** 仪器当前有效期（最近一次检定） */
export function latestCalibration(instrument: CalibrationInstrument): CalibrationRecord | undefined {
  return instrument.calibrations[instrument.calibrations.length - 1];
}
