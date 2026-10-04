<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useInstrumentStore } from '../stores/instrumentStore';
import { useClockStore } from '../stores/clockStore';
import { useStepStore } from '../stores/stepStore';
import StateBadge from '../components/common/StateBadge.vue';
import {
  isInstrumentUsable,
  latestCalibration,
  type CalibrationInstrument,
  type CalibrationRecord,
  type InstrumentDraft,
} from '../types/instrument';
import { RESERVATION_TTL_MS, isReservationAlive } from '../types/reservation';
import { forceReleaseReservation, reclaimStaleReservations } from '../utils/booking';
import { testEvidenceOf, type TestEvidence } from '../types/test';

const router = useRouter();
const instrumentStore = useInstrumentStore();
const clockStore = useClockStore();
const stepStore = useStepStore();

const activeTab = ref('instruments');

// —— 新建仪器 ——
const createVisible = ref(false);
const createForm = reactive<InstrumentDraft>({
  instrumentNo: '',
  name: '',
  maker: '',
  status: '在用',
  location: '',
  calibrations: [],
});

function openCreate() {
  createVisible.value = true;
  Object.assign(createForm, { instrumentNo: '', name: '', maker: '', status: '在用', location: '', calibrations: [] });
}

async function submitCreate() {
  if (!createForm.instrumentNo.trim()) {
    ElMessage.error('资产编号必填');
    return;
  }
  if (instrumentStore.items.some((it) => it.instrumentNo === createForm.instrumentNo.trim())) {
    ElMessage.error('资产编号已存在');
    return;
  }
  await instrumentStore.add({ ...createForm, instrumentNo: createForm.instrumentNo.trim() });
  createVisible.value = false;
  ElMessage.success('仪器已登记');
}

// —— 补检 ——
const calibVisible = ref(false);
const calibTarget = ref<CalibrationInstrument | undefined>(undefined);
const calibForm = reactive({
  certNo: '',
  certOrg: '',
  validUntil: defaultValidUntil(),
  result: '合格',
});

function defaultValidUntil(): Date {
  return new Date(Date.now() + 365 * 24 * 3600 * 1000);
}

function openCalib(row: CalibrationInstrument) {
  calibTarget.value = row;
  calibVisible.value = true;
  calibForm.certNo = '';
  calibForm.certOrg = '';
  calibForm.validUntil = defaultValidUntil();
  calibForm.result = '合格';
}

async function submitCalib() {
  if (!calibTarget.value) return;
  if (!calibForm.certNo.trim()) {
    ElMessage.error('证书编号必填');
    return;
  }
  if (!calibForm.validUntil || calibForm.validUntil.getTime() <= Date.now()) {
    ElMessage.error('检定有效期必须晚于当前时间');
    return;
  }
  try {
    await ElMessageBox.confirm(
      `补检后，${calibTarget.value.instrumentNo} 名下 ${affectedCount(calibTarget.value.id)} 条历史测试将立即失效、相关钟表撤下完工结论，需复测确认。确认补检？`,
      '补检将使历史测试失效',
      { type: 'warning', confirmButtonText: '确认补检', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }
  const record: CalibrationRecord = {
    calibratedAt: Date.now(),
    certNo: calibForm.certNo.trim(),
    certOrg: calibForm.certOrg.trim(),
    validUntil: calibForm.validUntil.getTime(),
    result: calibForm.result,
  };
  await instrumentStore.addCalibration(calibTarget.value.id, record);
  calibVisible.value = false;
  ElMessage.success('补检已登记，相关测试已标记失效，请安排复测');
}

// —— 改有效期 ——
const validityVisible = ref(false);
const validityTarget = ref<CalibrationInstrument | undefined>(undefined);
const validityCertNo = ref('');
const validityUntil = ref<Date>(new Date());

function openValidity(row: CalibrationInstrument) {
  const cert = latestCalibration(row);
  if (!cert) {
    ElMessage.warning('该仪器尚无检定记录，请先补检');
    return;
  }
  validityTarget.value = row;
  validityCertNo.value = cert.certNo;
  validityUntil.value = new Date(cert.validUntil);
  validityVisible.value = true;
}

async function submitValidity() {
  if (!validityTarget.value) return;
  if (!validityUntil.value) {
    ElMessage.error('请选择新的有效期');
    return;
  }
  await instrumentStore.updateValidity(
    validityTarget.value.id,
    validityCertNo.value,
    validityUntil.value.getTime(),
  );
  validityVisible.value = false;
  ElMessage.success('检定有效期已修改，相关测试已标记失效，请安排复测');
}

// —— 停用/启用 ——
async function toggleStatus(row: CalibrationInstrument) {
  if (row.status === '在用') {
    try {
      await ElMessageBox.confirm(
        `停用后，${row.instrumentNo} 名下 ${affectedCount(row.id)} 条历史测试将立即失效、相关钟表撤下完工结论。确认停用？`,
        '停用仪器',
        { type: 'warning', confirmButtonText: '停用', cancelButtonText: '取消' },
      );
    } catch {
      return;
    }
    await instrumentStore.setStatus(row.id, '停用');
    ElMessage.success('仪器已停用，相关测试已失效');
  } else {
    const cert = latestCalibration(row);
    if (!cert || cert.validUntil <= Date.now()) {
      ElMessage.warning('启用前请先补检，当前不在检定有效期内');
    }
    await instrumentStore.setStatus(row.id, '在用');
    ElMessage.success('仪器已启用');
  }
}

function affectedCount(instrumentId: string): number {
  return stepStore.tests.filter(
    (t) => testEvidenceOf(t, instrumentStore.items) === 'valid' && t.instrumentRef?.instrumentId === instrumentId,
  ).length;
}

// —— 检定历史 ——
const historyVisible = ref(false);
const historyTarget = ref<CalibrationInstrument | undefined>(undefined);
function openHistory(row: CalibrationInstrument) {
  historyTarget.value = row;
  historyVisible.value = true;
}

// —— 预约页签 ——
const reservations = computed(() =>
  instrumentStore.reservations.map((r) => {
    const alive = isReservationAlive(r, Date.now());
    return {
      ...r,
      alive,
      instrument: instrumentStore.byId(r.instrumentId),
      clock: clockStore.byId(r.clockId),
    };
  }),
);

async function reclaim() {
  const n = await reclaimStaleReservations();
  await instrumentStore.refresh();
  ElMessage[n > 0 ? 'success' : 'info'](`已回收 ${n} 条中断超时的预约`);
}

async function forceRelease(id: string) {
  await forceReleaseReservation(id);
  await instrumentStore.refresh();
  ElMessage.success('预约已释放');
}

// —— 待补证/失效测试 ——
interface EvidenceRow {
  evidence: TestEvidence;
  test: (typeof stepStore.tests)[number];
  clock: ReturnType<typeof clockStore.byId>;
  instrument: CalibrationInstrument | undefined;
}

const evidenceRows = computed<EvidenceRow[]>(() =>
  stepStore.tests
    .map((test) => {
      const evidence = testEvidenceOf(test, instrumentStore.items);
      return {
        evidence,
        test,
        clock: clockStore.byId(test.clockId),
        instrument: test.instrumentRef
          ? instrumentStore.byId(test.instrumentRef.instrumentId)
          : undefined,
      };
    })
    .filter((row) => row.evidence !== 'valid')
    .sort((a, b) => b.test.testedAt - a.test.testedAt),
);

function fmt(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}
function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString('zh-CN');
}

onMounted(async () => {
  await instrumentStore.load();
  await clockStore.load();
  await stepStore.load();
});
</script>

<template>
  <div class="page">
    <div class="header">
      <h2>仪器台账</h2>
      <el-tag>共 {{ instrumentStore.items.length }} 台</el-tag>
      <el-tag type="success" effect="plain">当前可用 {{ instrumentStore.usable.length }} 台</el-tag>
      <div class="spacer" />
      <el-button type="primary" @click="openCreate">登记仪器</el-button>
    </div>

    <el-tabs v-model="activeTab">
      <!-- 仪器台账 -->
      <el-tab-pane label="仪器台账" name="instruments">
        <el-table :data="instrumentStore.items" size="small" border>
          <el-table-column prop="instrumentNo" label="资产编号" width="140" />
          <el-table-column prop="name" label="名称/型号" min-width="200" />
          <el-table-column prop="maker" label="厂家" width="110" />
          <el-table-column prop="location" label="存放位置" width="140" />
          <el-table-column label="状态" width="90">
            <template #default="{ row }">
              <StateBadge :label="row.status" :tone="row.status === '在用' ? 'success' : 'info'" />
            </template>
          </el-table-column>
          <el-table-column label="最近检定" min-width="240">
            <template #default="{ row }">
              <template v-if="latestCalibration(row)">
                <el-tag size="small" :type="isInstrumentUsable(row) ? 'success' : 'danger'">
                  {{ isInstrumentUsable(row) ? '检定有效' : '已过检' }}
                </el-tag>
                <span class="muted">
                  {{ latestCalibration(row)!.certNo }} · 至 {{ fmtDate(latestCalibration(row)!.validUntil) }}
                </span>
              </template>
              <el-tag v-else size="small" type="danger">未检定</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="证书版本" width="90">
            <template #default="{ row }">v{{ row.certVersion }}</template>
          </el-table-column>
          <el-table-column label="操作" width="300" fixed="right">
            <template #default="{ row }">
              <el-button link type="primary" size="small" @click="openCalib(row)">补检</el-button>
              <el-button link type="primary" size="small" @click="openValidity(row)">改有效期</el-button>
              <el-button link type="primary" size="small" @click="openHistory(row)">检定记录</el-button>
              <el-button link :type="row.status === '在用' ? 'danger' : 'success'" size="small" @click="toggleStatus(row)">
                {{ row.status === '在用' ? '停用' : '启用' }}
              </el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <!-- 时段预约 -->
      <el-tab-pane :label="`时段预约（${reservations.filter((r) => r.alive).length} 占用中）`" name="reservations">
        <div class="tab-toolbar">
          <el-alert
            type="info"
            :closable="false"
            show-icon
            style="flex: 1"
            :title="`页签关闭/中断后预约最多残留 ${RESERVATION_TTL_MS / 1000}s 心跳，超时即可被他人接管；也可在此手动回收。`"
          />
          <el-button @click="reclaim">回收中断超时预约</el-button>
        </div>
        <el-table :data="reservations" size="small" border style="margin-top: 10px">
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag size="small" :type="row.alive ? 'success' : row.status === 'done' ? 'primary' : 'info'">
                {{ row.alive ? '占用中' : row.status === 'done' ? '已完成' : row.status === 'released' ? '已取消' : '已中断' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="仪器" min-width="180">
            <template #default="{ row }">{{ row.instrument?.instrumentNo ?? '—' }} {{ row.instrument?.name ?? '' }}</template>
          </el-table-column>
          <el-table-column label="钟表" min-width="160">
            <template #default="{ row }">
              <el-button link type="primary" @click="router.push(`/clocks/${row.clockId}`)">
                {{ row.clock?.clockNo ?? '钟表已删除' }}
              </el-button>
            </template>
          </el-table-column>
          <el-table-column label="时段" min-width="280">
            <template #default="{ row }">{{ fmt(row.startAt) }} – {{ new Date(row.endAt).toLocaleTimeString('zh-CN', { hour12: false }) }}</template>
          </el-table-column>
          <el-table-column label="心跳时间" width="180">
            <template #default="{ row }">{{ fmt(row.heartbeatAt) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="150">
            <template #default="{ row }">
              <el-button
                v-if="row.alive"
                link
                type="warning"
                size="small"
                @click="forceRelease(row.id)"
              >
                释放
              </el-button>
              <el-button link type="primary" size="small" @click="router.push(`/tests/${row.clockId}`)">去测试页</el-button>
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-if="reservations.length === 0" description="暂无预约记录" :image-size="60" />
      </el-tab-pane>

      <!-- 待补证 / 失效测试 -->
      <el-tab-pane :label="`待补证与失效（${evidenceRows.length}）`" name="evidence">
        <el-alert
          type="warning"
          :closable="false"
          show-icon
          title="以下测试不能作为完工依据：旧测试无仪器记录的列入待补证，不沿用原合格结果；仪器停用、补检或改有效期的立即失效。须用在检定有效期内的仪器复测确认。"
          style="margin-bottom: 10px"
        />
        <el-table :data="evidenceRows" size="small" border>
          <el-table-column label="测试时间" width="180">
            <template #default="{ row }">{{ fmt(row.test.testedAt) }}</template>
          </el-table-column>
          <el-table-column label="钟表" min-width="150">
            <template #default="{ row }">
              <el-button link type="primary" @click="router.push(`/clocks/${row.clock?.id ?? ''}`)">
                {{ row.clock?.clockNo ?? '钟表已删除' }}
              </el-button>
            </template>
          </el-table-column>
          <el-table-column prop="test.conclusion" label="原结论" width="110">
            <template #default="{ row }">{{ row.test.conclusion || '—' }}</template>
          </el-table-column>
          <el-table-column label="原仪器/证书" min-width="200">
            <template #default="{ row }">
              <span v-if="row.test.instrumentRef" class="muted">
                {{ row.test.instrumentRef.instrumentNo }} · {{ row.test.instrumentRef.certNo }}
                <template v-if="!row.instrument">（仪器已删除）</template>
              </span>
              <el-tag v-else size="small" type="warning">无仪器记录</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="凭证状态" width="110">
            <template #default="{ row }">
              <el-tag size="small" :type="row.evidence === 'invalid' ? 'danger' : 'warning'">
                {{ row.evidence === 'invalid' ? '已失效' : '待补证' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="120">
            <template #default="{ row }">
              <el-button link type="primary" size="small" @click="router.push(`/tests/${row.test.clockId}`)">安排复测</el-button>
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-if="evidenceRows.length === 0" description="没有待补证或失效的测试" :image-size="60" />
      </el-tab-pane>
    </el-tabs>

    <!-- 登记仪器 -->
    <el-dialog v-model="createVisible" title="登记校表仪" width="560px">
      <el-form :model="createForm" label-width="110px">
        <el-form-item label="资产编号" required>
          <el-input v-model="createForm.instrumentNo" placeholder="如 WTC-III-01" />
        </el-form-item>
        <el-form-item label="名称/型号">
          <el-input v-model="createForm.name" />
        </el-form-item>
        <el-form-item label="厂家">
          <el-input v-model="createForm.maker" />
        </el-form-item>
        <el-form-item label="存放位置">
          <el-input v-model="createForm.location" />
        </el-form-item>
        <el-form-item label="状态">
          <el-radio-group v-model="createForm.status">
            <el-radio-button value="在用">在用</el-radio-button>
            <el-radio-button value="停用">停用</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-alert
          type="info"
          :closable="false"
          title="新仪器尚无检定记录，需补检后才能预约测试。"
        />
      </el-form>
      <template #footer>
        <el-button @click="createVisible = false">取消</el-button>
        <el-button type="primary" @click="submitCreate">保存</el-button>
      </template>
    </el-dialog>

    <!-- 补检 -->
    <el-dialog v-model="calibVisible" :title="`补检登记 · ${calibTarget?.instrumentNo ?? ''}`" width="520px">
      <el-form :model="calibForm" label-width="110px">
        <el-form-item label="证书编号" required>
          <el-input v-model="calibForm.certNo" placeholder="如 JL-2026-0888" />
        </el-form-item>
        <el-form-item label="检定机构">
          <el-input v-model="calibForm.certOrg" />
        </el-form-item>
        <el-form-item label="检定结果">
          <el-input v-model="calibForm.result" />
        </el-form-item>
        <el-form-item label="有效期至" required>
          <el-date-picker v-model="calibForm.validUntil" type="date" style="width: 100%" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="calibVisible = false">取消</el-button>
        <el-button type="primary" @click="submitCalib">确认补检（旧测试失效）</el-button>
      </template>
    </el-dialog>

    <!-- 改有效期 -->
    <el-dialog v-model="validityVisible" :title="`修改检定有效期 · ${validityTarget?.instrumentNo ?? ''}`" width="480px">
      <el-form label-width="110px">
        <el-form-item label="证书编号">
          <el-input :model-value="validityCertNo" disabled />
        </el-form-item>
        <el-form-item label="新有效期至">
          <el-date-picker v-model="validityUntil" type="date" style="width: 100%" />
        </el-form-item>
      </el-form>
      <el-alert type="warning" :closable="false" title="修改后引用该仪器的测试立即失效，须复测确认。" />
      <template #footer>
        <el-button @click="validityVisible = false">取消</el-button>
        <el-button type="primary" @click="submitValidity">保存并使旧测试失效</el-button>
      </template>
    </el-dialog>

    <!-- 检定历史 -->
    <el-dialog v-model="historyVisible" :title="`检定记录 · ${historyTarget?.instrumentNo ?? ''}`" width="620px">
      <el-timeline v-if="historyTarget">
        <el-timeline-item
          v-for="(c, i) in [...historyTarget.calibrations].reverse()"
          :key="c.certNo"
          :timestamp="fmt(c.calibratedAt)"
          :type="i === 0 ? (c.validUntil > Date.now() ? 'success' : 'danger') : 'info'"
        >
          <p><strong>{{ c.certNo }}</strong> · {{ c.certOrg }} · {{ c.result }}</p>
          <p class="muted">有效期至 {{ fmtDate(c.validUntil) }}</p>
        </el-timeline-item>
      </el-timeline>
      <el-empty v-if="historyTarget && historyTarget.calibrations.length === 0" description="暂无检定记录" :image-size="60" />
    </el-dialog>
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
}
.header h2 {
  margin: 0;
}
.spacer {
  flex: 1;
}
.tab-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
}
.muted {
  color: #7b8592;
  font-size: 13px;
}
</style>
