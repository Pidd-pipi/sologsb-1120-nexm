<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useClockStore } from '../stores/clockStore';
import { useStepStore } from '../stores/stepStore';
import { useInstrumentStore } from '../stores/instrumentStore';
import RateChart from '../components/common/RateChart.vue';
import StateBadge from '../components/common/StateBadge.vue';
import { TEST_POSITIONS, judgeTest, testEvidenceOf, TEST_EVIDENCE_LABEL, type PositionReading } from '../types/test';
import { latestCalibration } from '../types/instrument';
import {
  RESERVATION_HEARTBEAT_MS,
  RESERVATION_TTL_MS,
  isReservationAlive,
  type InstrumentReservation,
} from '../types/reservation';
import {
  BookingError,
  completeReservationWithTest,
  findSlotClash,
  heartbeat,
  interruptReservation,
  releaseReservation,
  reserveSlot,
} from '../utils/booking';
import { amplitudeLevel, avgAmplitude, avgBeatError, avgRate, beatErrorLevel, rateLabel, ratePerDayToMonth } from '../utils/timeCalc';

const route = useRoute();
const router = useRouter();
const clockStore = useClockStore();
const stepStore = useStepStore();
const instrumentStore = useInstrumentStore();

const clockId = ref(String(route.params.clockId ?? ''));
const clock = computed(() => clockStore.byId(clockId.value));
const tests = computed(() => stepStore.testsByClock(clockId.value));

const readings = reactive<PositionReading[]>(
  TEST_POSITIONS.map((position) => ({ position, rate: 0, amplitude: 260, beatError: 0.4 })),
);
const powerReserve = ref(42);
const customConclusion = ref('');

// —— 测前预约 ——
const selectedInstrumentId = ref('');
const slotRange = ref<[Date, Date]>(defaultSlot());
const clashInfo = ref<InstrumentReservation | undefined>(undefined);
const currentReservation = ref<InstrumentReservation | undefined>(undefined);
const reserveLoading = ref(false);
let heartbeatTimer: number | undefined;

function defaultSlot(): [Date, Date] {
  const start = new Date(Math.ceil(Date.now() / (30 * 60000)) * 30 * 60000);
  const end = new Date(start.getTime() + 60 * 60000);
  return [start, end];
}

const selectedInstrument = computed(() => instrumentStore.byId(selectedInstrumentId.value));
const selectedCert = computed(() =>
  selectedInstrument.value ? latestCalibration(selectedInstrument.value) : undefined,
);
const selectedBlockReason = computed(() => {
  if (!selectedInstrument.value) return '';
  const latest = selectedCert.value;
  if (selectedInstrument.value.status === '停用') return '该仪器已停用，不能预约';
  if (!latest) return '该仪器尚无检定记录';
  if (latest.validUntil <= Date.now()) return `检定已于 ${new Date(latest.validUntil).toLocaleDateString('zh-CN')} 到期，请先补检`;
  if (latest.validUntil < slotRange.value[1]?.getTime()) return '检定有效期不能覆盖预约结束时间';
  return '';
});

/** 本页签当前是否仍有效持有预约（心跳未超时） */
const holding = computed(
  () => !!currentReservation.value && isReservationAlive(currentReservation.value, Date.now()),
);

const avg = computed(() => ({
  rate: avgRate(readings),
  amplitude: avgAmplitude(readings),
  beatError: avgBeatError(readings),
}));

const conclusion = computed(() =>
  customConclusion.value.trim() ? customConclusion.value.trim() : judgeTest(avg.value.rate, avg.value.beatError, avg.value.amplitude),
);

const workSheet = computed(() => {
  const lines: string[] = [];
  lines.push('走时测试单');
  lines.push(`藏品号：${clock.value?.clockNo ?? '未知'}（${clock.value?.kind ?? ''} / ${clock.value?.caliber ?? ''}）`);
  lines.push(`测试时间：${new Date().toLocaleString('zh-CN')}`);
  if (selectedInstrument.value && selectedCert.value) {
    lines.push(`校表仪：${selectedInstrument.value.instrumentNo} ${selectedInstrument.value.name}`);
    lines.push(`检定证书：${selectedCert.value.certNo}（有效期至 ${new Date(selectedCert.value.validUntil).toLocaleDateString('zh-CN')}）`);
  }
  lines.push('');
  lines.push('方位\t日差(s/d)\t摆幅(°)\t偏振(ms)');
  readings.forEach((r) => {
    lines.push(`${r.position}\t${r.rate}\t${r.amplitude}\t${r.beatError}`);
  });
  lines.push('');
  lines.push(`平均日差：${avg.value.rate} s/d（约 ${ratePerDayToMonth(avg.value.rate)} s/月，${rateLabel(avg.value.rate)}）`);
  lines.push(`平均摆幅：${avg.value.amplitude} °（${amplitudeLevel(avg.value.amplitude).label}）`);
  lines.push(`平均偏振：${avg.value.beatError} ms（${beatErrorLevel(avg.value.beatError).label}）`);
  lines.push(`动力储备：${powerReserve.value} h`);
  lines.push(`结论：${conclusion.value}`);
  return lines.join('\n');
});

async function checkClash() {
  clashInfo.value = undefined;
  if (!selectedInstrumentId.value || !slotRange.value) return;
  clashInfo.value = await findSlotClash(
    selectedInstrumentId.value,
    slotRange.value[0].getTime(),
    slotRange.value[1].getTime(),
  );
}

async function reserve() {
  if (!clockId.value) {
    ElMessage.error('未指定钟表');
    return;
  }
  if (!selectedInstrumentId.value) {
    ElMessage.error('请先选择校表仪');
    return;
  }
  if (selectedBlockReason.value) {
    ElMessage.error(selectedBlockReason.value);
    return;
  }
  if (!slotRange.value || slotRange.value[1].getTime() <= slotRange.value[0].getTime()) {
    ElMessage.error('预约时段无效');
    return;
  }
  reserveLoading.value = true;
  try {
    const r = await reserveSlot({
      instrumentId: selectedInstrumentId.value,
      clockId: clockId.value,
      startAt: slotRange.value[0].getTime(),
      endAt: slotRange.value[1].getTime(),
      purpose: '走时测试',
    });
    currentReservation.value = r;
    await instrumentStore.refresh();
    startHeartbeat();
    ElMessage.success(`已预约 ${selectedInstrument.value?.instrumentNo}，请按时完成测试`);
  } catch (err) {
    currentReservation.value = undefined;
    ElMessage.error(err instanceof BookingError ? err.message : '预约失败，请重试');
  } finally {
    reserveLoading.value = false;
  }
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = window.setInterval(async () => {
    const r = currentReservation.value;
    if (!r) return;
    const ok = await heartbeat(r.id);
    if (ok && currentReservation.value) {
      currentReservation.value = { ...currentReservation.value, heartbeatAt: Date.now() };
    } else {
      // 被他人接管或记录丢失：停止占用，提示重新预约
      stopHeartbeat();
      currentReservation.value = undefined;
      ElMessage.warning('预约已中断（可能在其他页签释放或心跳超时），时段已让出，请重新预约');
    }
  }, RESERVATION_HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer !== undefined) {
    window.clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }
}

async function cancelReservation(interrupt = false) {
  const r = currentReservation.value;
  if (!r) return;
  try {
    if (interrupt) await interruptReservation(r.id);
    else await releaseReservation(r.id);
  } finally {
    stopHeartbeat();
    currentReservation.value = undefined;
    await instrumentStore.refresh();
    ElMessage.info(interrupt ? '预约已中断，仪器时段已释放' : '预约已取消');
  }
}

async function save() {
  if (!clockId.value) {
    ElMessage.error('未指定钟表');
    return;
  }
  if (!currentReservation.value) {
    ElMessage.error('请先选择在检定有效期内的校表仪并预约时段');
    return;
  }
  if (!holding.value) {
    ElMessage.error('预约心跳已中断，请重新预约仪器');
    currentReservation.value = undefined;
    stopHeartbeat();
    return;
  }
  try {
    await completeReservationWithTest(
      {
        clockId: clockId.value,
        testedAt: Date.now(),
        amplitude: avg.value.amplitude,
        beatError: avg.value.beatError,
        rate: avg.value.rate,
        positions: readings.map((r) => ({ ...r })),
        powerReserve: powerReserve.value,
        conclusion: conclusion.value,
      },
      currentReservation.value.id,
    );
  } catch (err) {
    ElMessage.error(err instanceof BookingError ? err.message : '保存失败，请重试');
    return;
  }
  stopHeartbeat();
  currentReservation.value = undefined;
  await stepStore.refresh();
  await instrumentStore.refresh();
  ElMessage.success('走时测试已记录（仪器凭证与时段已核验）');
  resetReadings();
}

async function removeTest(id: string) {
  try {
    await ElMessageBox.confirm('删除该测试记录？', '确认', { type: 'warning' });
  } catch {
    return;
  }
  await stepStore.removeTest(id);
  ElMessage.success('测试记录已删除');
}

async function copySheet() {
  try {
    await navigator.clipboard.writeText(workSheet.value);
    ElMessage.success('走时单已复制');
  } catch {
    ElMessage.warning('浏览器未授权剪贴板，请手动复制');
  }
}

function downloadSheet() {
  const blob = new Blob([workSheet.value], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `走时单_${clock.value?.clockNo ?? 'clock'}.txt`;
  a.click();
  URL.revokeObjectURL(url);
  ElMessage.success('走时单已导出');
}

function resetReadings() {
  readings.forEach((r) => {
    r.rate = 0;
    r.amplitude = 260;
    r.beatError = 0.4;
  });
  customConclusion.value = '';
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

function evidenceTagType(t: (typeof tests.value)[number]): 'success' | 'danger' | 'warning' {
  const evidence = testEvidenceOf(t, instrumentStore.items);
  if (evidence === 'valid') return 'success';
  if (evidence === 'invalid') return 'danger';
  return 'warning';
}

function evidenceLabelOf(t: (typeof tests.value)[number]): string {
  return TEST_EVIDENCE_LABEL[testEvidenceOf(t, instrumentStore.items)];
}

// 页签关闭/刷新：中断而不是挂着占用（心跳 TTL 兜底崩溃场景）
function onBeforeUnload(e: BeforeUnloadEvent) {
  if (currentReservation.value) {
    void interruptReservation(currentReservation.value.id);
    e.preventDefault();
    e.returnValue = '';
  }
}

// 同页签内切换到别的钟表测试：先让出当前仪器时段，不能占着
watch(clockId, (next, prev) => {
  if (next && prev && next !== prev && currentReservation.value) {
    void cancelReservation(true);
  }
});

onMounted(async () => {
  await clockStore.load();
  await stepStore.load();
  await instrumentStore.load();
  if (!clock.value && clockStore.items.length > 0) {
    clockId.value = clockStore.items[0].id;
    await router.replace(`/tests/${clockId.value}`);
  }
  selectedInstrumentId.value = instrumentStore.usable[0]?.id ?? '';
  await checkClash();
  window.addEventListener('beforeunload', onBeforeUnload);
  document.addEventListener('visibilitychange', onVisibilityChange);
});

function onVisibilityChange() {
  if (document.visibilityState === 'visible') {
    void instrumentStore.refresh();
    void stepStore.refresh();
  }
}

onBeforeUnmount(() => {
  stopHeartbeat();
  window.removeEventListener('beforeunload', onBeforeUnload);
  document.removeEventListener('visibilitychange', onVisibilityChange);
  if (currentReservation.value) void interruptReservation(currentReservation.value.id);
});
</script>

<template>
  <div class="page">
    <div class="header">
      <h2>走时测试 · {{ clock?.clockNo ?? '未选择' }}</h2>
      <StateBadge :grade="clock?.conditionGrade" />
      <el-tag type="info" effect="plain">历史测试 {{ tests.length }} 次</el-tag>
      <div class="spacer" />
      <el-button @click="router.push(`/clocks/${clockId}`)">返回钟表详情</el-button>
    </div>

    <div class="grid">
      <el-card shadow="never">
        <template #header><strong>测前准备 · 选择校表仪与时段</strong></template>

        <el-alert
          v-if="!holding"
          type="info"
          :closable="false"
          show-icon
          style="margin-bottom: 12px"
          title="必须选择在检定有效期内的在用仪器并预约时段；停用、过检或时段冲突均会被拒绝。"
        />
        <el-alert
          v-else
          type="success"
          :closable="false"
          show-icon
          style="margin-bottom: 12px"
          :title="`已占用仪器：${fmtTime(currentReservation!.startAt)} – ${new Date(currentReservation!.endAt).toLocaleTimeString('zh-CN', { hour12: false })}（心跳 ${RESERVATION_TTL_MS / 1000}s）`"
          description="请尽快录入读数并保存；离开或关闭页签将中断预约并立即释放时段。"
        />

        <el-form label-width="110px">
          <el-form-item label="校表仪" required>
            <el-select
              v-model="selectedInstrumentId"
              :disabled="holding"
              placeholder="选择校表仪"
              style="width: 100%"
              @change="checkClash"
            >
              <el-option
                v-for="ins in instrumentStore.items"
                :key="ins.id"
                :label="`${ins.instrumentNo} ${ins.name}（${ins.status}${
                  latestCalibration(ins) ? '，有效期至 ' + new Date(latestCalibration(ins)!.validUntil).toLocaleDateString('zh-CN') : '，未检定'
                }）`"
                :value="ins.id"
                :disabled="!instrumentStore.usable.some((u) => u.id === ins.id)"
              />
            </el-select>
          </el-form-item>
          <el-form-item v-if="selectedInstrument" label="检定信息">
            <div v-if="selectedCert" class="cert-line">
              <el-tag size="small" :type="selectedBlockReason ? 'danger' : 'success'">
                {{ selectedBlockReason ? '不可用' : '在有效期内' }}
              </el-tag>
              <span class="muted">
                证书 {{ selectedCert.certNo }} · {{ selectedCert.certOrg }} ·
                有效期至 {{ new Date(selectedCert.validUntil).toLocaleDateString('zh-CN') }}
              </span>
            </div>
            <span v-else class="muted">该仪器尚无检定记录</span>
          </el-form-item>
          <el-form-item label="预约时段" required>
            <el-date-picker
              v-model="slotRange"
              type="datetimerange"
              :disabled="holding"
              range-separator="至"
              start-placeholder="开始"
              end-placeholder="结束"
              format="MM-DD HH:mm"
              :minute-step="10"
              style="width: 100%"
              @change="checkClash"
            />
          </el-form-item>
          <el-alert
            v-if="clashInfo && !holding"
            type="error"
            :closable="false"
            show-icon
            style="margin-bottom: 10px"
            :title="`时段已被占用：${fmtTime(clashInfo.startAt)} – ${new Date(clashInfo.endAt).toLocaleTimeString('zh-CN', { hour12: false })}，请改约其他时段或仪器`"
          />
          <el-form-item>
            <el-button v-if="!holding" type="primary" :loading="reserveLoading" @click="reserve">预约仪器时段</el-button>
            <template v-else>
              <el-button type="warning" @click="cancelReservation(false)">取消预约</el-button>
              <el-button type="danger" plain @click="cancelReservation(true)">中断并释放</el-button>
            </template>
          </el-form-item>
        </el-form>
      </el-card>

      <el-card shadow="never">
        <template #header><strong>多方位读数录入</strong></template>
        <el-table :data="readings" size="small" border>
          <el-table-column prop="position" label="方位" width="90" />
          <el-table-column label="日差 s/d" width="150">
            <template #default="{ row }">
              <el-input-number v-model="row.rate" :min="-99" :max="99" :step="0.1" :precision="1" size="small" />
            </template>
          </el-table-column>
          <el-table-column label="摆幅 °" width="160">
            <template #default="{ row }">
              <el-input-number v-model="row.amplitude" :min="0" :max="400" :step="1" size="small" />
            </template>
          </el-table-column>
          <el-table-column label="偏振 ms" width="160">
            <template #default="{ row }">
              <el-input-number v-model="row.beatError" :min="0" :max="9.9" :step="0.1" :precision="1" size="small" />
            </template>
          </el-table-column>
          <el-table-column label="分级" min-width="140">
            <template #default="{ row }">
              <StateBadge :label="amplitudeLevel(row.amplitude).label" :tone="amplitudeLevel(row.amplitude).type" />
              <StateBadge :label="beatErrorLevel(row.beatError).label" :tone="beatErrorLevel(row.beatError).type" />
            </template>
          </el-table-column>
        </el-table>

        <el-form label-width="110px" style="margin-top: 14px">
          <el-form-item label="动力储备 h">
            <el-input-number v-model="powerReserve" :min="0" :max="400" />
          </el-form-item>
          <el-form-item label="结论（可选）">
            <el-input v-model="customConclusion" placeholder="留空则按均值自动判定" />
          </el-form-item>
          <el-form-item>
            <el-button type="primary" :disabled="!holding" @click="save">保存测试记录</el-button>
            <el-button @click="resetReadings">重置读数</el-button>
            <span v-if="!holding" class="muted">未持有有效仪器预约，不能保存</span>
          </el-form-item>
        </el-form>
      </el-card>

      <el-card shadow="never">
        <template #header><strong>多方位均值</strong></template>
        <div class="stats">
          <div><span class="muted">平均日差</span><strong>{{ avg.rate }}</strong> s/d</div>
          <div><span class="muted">折算</span><strong>{{ ratePerDayToMonth(avg.rate) }}</strong> s/月</div>
          <div><span class="muted">平均摆幅</span><strong>{{ avg.amplitude }}</strong> °</div>
          <div><span class="muted">平均偏振</span><strong>{{ avg.beatError }}</strong> ms</div>
        </div>
        <el-alert
          :title="`判定结论：${conclusion}（${rateLabel(avg.rate)}）`"
          :type="conclusion === '合格' ? 'success' : conclusion === '不合格' ? 'error' : 'warning'"
          :closable="false"
          show-icon
        />
        <RateChart :readings="readings" />
      </el-card>

      <el-card shadow="never">
        <template #header>
          <div class="card-head">
            <strong>走时单</strong>
            <div class="spacer" />
            <el-button size="small" @click="copySheet">复制</el-button>
            <el-button size="small" type="primary" @click="downloadSheet">导出</el-button>
          </div>
        </template>
        <el-input v-model="workSheet" type="textarea" :rows="12" readonly />
      </el-card>

      <el-card shadow="never" class="history">
        <template #header><strong>历史测试记录</strong></template>
        <el-table :data="tests" size="small" border>
          <el-table-column label="时间" width="170">
            <template #default="{ row }">{{ new Date(row.testedAt).toLocaleString('zh-CN') }}</template>
          </el-table-column>
          <el-table-column prop="rate" label="日差" width="80" />
          <el-table-column prop="amplitude" label="摆幅" width="80" />
          <el-table-column prop="beatError" label="偏振" width="80" />
          <el-table-column prop="powerReserve" label="动储 h" width="90" />
          <el-table-column prop="conclusion" label="结论" width="110" />
          <el-table-column label="凭证" width="100">
            <template #default="{ row }">
              <el-tag size="small" :type="evidenceTagType(row)">{{ evidenceLabelOf(row) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="校表仪 / 证书" min-width="180">
            <template #default="{ row }">
              <span v-if="row.instrumentRef" class="muted">
                {{ row.instrumentRef.instrumentNo }} · {{ row.instrumentRef.certNo }}
              </span>
              <el-tag v-else size="small" type="warning">无仪器记录</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="80">
            <template #default="{ row }">
              <el-button link type="danger" size="small" @click="removeTest(row.id)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-if="tests.length === 0" description="暂无历史测试" :image-size="60" />
      </el-card>
    </div>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.header {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.header h2 {
  margin: 0;
}
.spacer {
  flex: 1;
}
.grid {
  display: grid;
  grid-template-columns: minmax(0, 480px) minmax(0, 1fr);
  gap: 14px;
  align-items: start;
}
.history {
  grid-column: 1 / -1;
}
.stats {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-bottom: 10px;
  font-size: 14px;
}
.stats strong {
  font-size: 18px;
  margin: 0 4px;
}
.muted {
  color: #7b8592;
  font-size: 13px;
}
.cert-line {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.card-head {
  display: flex;
  align-items: center;
}
</style>
