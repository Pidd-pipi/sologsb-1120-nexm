import { computed, unref, type Ref } from 'vue';
import { useStepStore } from '../stores/stepStore';
import { useInstrumentStore } from '../stores/instrumentStore';
import type { RepairStep } from '../types/step';
import { isPassingTest, testEvidenceOf, type TimekeepingTest, type TestEvidence } from '../types/test';
import type { RepairState } from '../types/clock';

export interface ClockCompletion {
  state: RepairState;
  tests: TimekeepingTest[];
  /** 凭证有效的测试 */
  validTests: TimekeepingTest[];
  /** 凭证有效且结论合格的测试——只有它能支撑完工 */
  passingTests: TimekeepingTest[];
  /** 旧测试无仪器记录或仪器已删除：待补证，不沿用原合格结论 */
  pendingEvidenceTests: TimekeepingTest[];
  /** 仪器停用/补检/改有效期后失效的测试 */
  invalidTests: TimekeepingTest[];
  /** 全部工序已完成 */
  allStepsDone: boolean;
}

/**
 * 由工序与走时测试凭证推导修复状态。
 * 待补证与已失效测试一律不算数：旧合格结论不沿用，
 * 仪器变动后钟表自动撤下「已完成」，复测确认合格后恢复。
 */
export function getClockCompletion(clockId: string): ClockCompletion {
  const stepStore = useStepStore();
  const instrumentStore = useInstrumentStore();

  const steps: RepairStep[] = stepStore.items.filter((it) => it.clockId === clockId);
  const tests = stepStore.tests
    .filter((it) => it.clockId === clockId)
    .sort((a, b) => b.testedAt - a.testedAt);
  const instruments = instrumentStore.items;

  const validTests: TimekeepingTest[] = [];
  const passingTests: TimekeepingTest[] = [];
  const pendingEvidenceTests: TimekeepingTest[] = [];
  const invalidTests: TimekeepingTest[] = [];
  tests.forEach((t) => {
    const evidence: TestEvidence = testEvidenceOf(t, instruments);
    if (evidence === 'valid') {
      validTests.push(t);
      if (isPassingTest(t, evidence)) passingTests.push(t);
    } else if (evidence === 'pending-evidence') {
      pendingEvidenceTests.push(t);
    } else {
      invalidTests.push(t);
    }
  });

  const done = steps.filter((s) => s.state === 'done').length;
  const allStepsDone = steps.length > 0 && done === steps.length;

  let state: RepairState = '未开工';
  if (steps.length === 0) state = '未开工';
  else if (allStepsDone && passingTests.length > 0) state = '已完成';
  else if (allStepsDone) state = '待测试';
  else if (done > 0) state = '维修中';

  return {
    state,
    tests,
    validTests,
    passingTests,
    pendingEvidenceTests,
    invalidTests,
    allStepsDone,
  };
}

/** 响应式版本：被钟表详情页与测试页消费 */
export function useClockCompletion(clockId: string | Ref<string>) {
  const id = computed(() => unref(clockId));
  return computed<ClockCompletion>(() => getClockCompletion(id.value));
}
