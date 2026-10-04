// 仪器预约/凭证的核心事务规则集成测试（node + fake-indexeddb，不进正式构建）
// 运行：npx tsx scripts/booking.test.ts
import assert from 'node:assert/strict';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';

// 浏览器全局垫片
Object.assign(globalThis, { indexedDB: new IDBFactory(), IDBKeyRange });

// sessionStorage：每个会话独立存储
function installSession(id: string) {
  const store = new Map<string, string>([['gbclockrepair:session-id', id]]);
  (globalThis as any).window = {
    sessionStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
  };
}
installSession('sess-A');

async function setup() {
  const { db } = await import('../src/utils/db');
  const { newId } = await import('../src/utils/id');
  const now = Date.now();
  const day = 86400000;
  const instrumentId = newId('ins');
  const clockId = newId('clk');
  await db.instruments.put({
    id: instrumentId,
    instrumentNo: 'WTC-T-01',
    name: '测试校表仪',
    maker: 'Witschi',
    status: '在用',
    location: '测试间',
    certVersion: 1,
    createdAt: now,
    calibrations: [
      { calibratedAt: now - 10 * day, certNo: 'CERT-1', certOrg: '计量院', validUntil: now + 100 * day, result: '合格' },
    ],
  });
  return { db, instrumentId, clockId, newId };
}

function draft(clockId: string) {
  return {
    clockId,
    testedAt: 0,
    amplitude: 260,
    beatError: 0.4,
    rate: 2,
    positions: [],
    powerReserve: 42,
    conclusion: '合格',
  };
}

async function main() {
  const { db, instrumentId, clockId } = await setup();

  const booking = await import('../src/utils/booking');
  const testTypes = await import('../src/types/test');
  const instrumentStore = await import('../src/stores/instrumentStore');

  const t0 = Date.now() + 3600000;
  const t1 = t0 + 3600000;
  const t2 = t1 + 3600000;

  // 1) A 预约 [t0,t1) 成功
  installSession('sess-A');
  const rsvA = await booking.reserveSlot({ instrumentId, clockId, startAt: t0, endAt: t1, purpose: '走时测试' });
  assert.equal(rsvA.sessionId, 'sess-A');
  console.log('✓ A 预约成功');

  // 2) B 在另一个页签抢同一时段：只能一人成功
  installSession('sess-B');
  await assert.rejects(
    () => booking.reserveSlot({ instrumentId, clockId, startAt: t0 + 60000, endAt: t1 - 60000, purpose: '走时测试' }),
    /已被占用/,
  );
  console.log('✓ B 抢同一台仪器同一时段被拒绝');

  // 3) B 预约紧邻不重叠时段 [t1,t2) 成功
  const rsvB = await booking.reserveSlot({ instrumentId, clockId, startAt: t1, endAt: t2, purpose: '走时测试' });
  assert.ok(rsvB.id);
  console.log('✓ B 预约首尾相接时段成功（半开区间不冲突）');

  // 4) B 不能拿 A 的预约保存测试
  await assert.rejects(
    () => booking.completeReservationWithTest(draft(clockId), rsvA.id),
    /属于其他页签/,
  );
  console.log('✓ B 无法使用 A 的预约');

  // 5) A 中断后时段立即释放，B 可立刻抢到
  installSession('sess-A');
  const interrupted = await booking.interruptReservation(rsvA.id);
  assert.equal(interrupted, true);
  installSession('sess-B');
  const rsvB2 = await booking.reserveSlot({ instrumentId, clockId, startAt: t0 + 1000, endAt: t1 - 1000, purpose: '走时测试' });
  assert.ok(rsvB2.id);
  console.log('✓ 预约中断不占坑，他人立即能约');

  // 6) 心跳超时（15s）后自动回收：手工构造过期 held
  installSession('sess-A');
  const staleRsv = await booking.reserveSlot({
    instrumentId, clockId, startAt: t2, endAt: t2 + 3600000, purpose: '走时测试',
  });
  await db.reservations.update(staleRsv.id, { heartbeatAt: Date.now() - 20000 });
  const n = await booking.reclaimStaleReservations();
  assert.equal(n, 1);
  const reclaimed = await booking.reserveSlot({
    instrumentId, clockId, startAt: t2 + 1, endAt: t2 + 1800000, purpose: '走时测试',
  });
  assert.ok(reclaimed.id);
  console.log('✓ 页签崩溃残留预约 TTL 后可被接管');

  // 7) B 凭自己的预约保存测试成功，凭证有效
  installSession('sess-B');
  const test = await booking.completeReservationWithTest(draft(clockId), rsvB.id);
  assert.equal(test.instrumentRef?.instrumentId, rsvB.instrumentId);
  assert.equal(test.instrumentRef?.certVersion, 1);
  const doneRow = await db.reservations.get(rsvB.id);
  assert.equal(doneRow?.status, 'done');
  console.log('✓ 持有效预约保存测试成功，预约转 done');

  // 8) 补检（certVersion+1）后测试立即失效
  const { useInstrumentStore } = instrumentStore;
  const pinia = (await import('pinia')).createPinia();
  const store = useInstrumentStore(pinia);
  await store.load();
  await store.addCalibration(instrumentId, {
    calibratedAt: Date.now(), certNo: 'CERT-2', certOrg: '计量院', validUntil: Date.now() + 200 * 86400000, result: '合格',
  });
  const instruments = await db.instruments.toArray();
  assert.equal(testTypes.testEvidenceOf(test, instruments), 'invalid');
  console.log('✓ 补检后历史测试立即失效');

  // 9) 停用后同样失效
  await store.setStatus(instrumentId, '停用');
  const afterDisable = await db.instruments.toArray();
  assert.equal(testTypes.testEvidenceOf(test, afterDisable), 'invalid');
  console.log('✓ 停用后测试失效，停用仪器不能再预约');
  installSession('sess-A');
  await assert.rejects(
    () => booking.reserveSlot({ instrumentId, clockId, startAt: t2 + 10000, endAt: t2 + 20000, purpose: '走时测试' }),
    /已停用/,
  );

  // 10) 改有效期 bump 版本，测试仍失效
  await store.setStatus(instrumentId, '在用');
  await store.updateValidity(instrumentId, 'CERT-2', Date.now() + 300 * 86400000);
  const afterValidity = await db.instruments.toArray();
  assert.equal(testTypes.testEvidenceOf(test, afterValidity), 'invalid');
  console.log('✓ 改有效期后测试失效');

  // 11) 旧测试无 instrumentRef：待补证，不沿用合格
  const legacy = { ...draft(clockId), id: 'tst_legacy' };
  assert.equal(testTypes.testEvidenceOf(legacy as any, afterValidity), 'pending-evidence');
  assert.equal(testTypes.isPassingTest(legacy as any, 'pending-evidence'), false);
  console.log('✓ 无仪器记录的旧测试列为待补证，不沿用原合格结果');

  // 12) 过检仪器：有效期已过不能预约
  const expiredId = 'ins_expired';
  await db.instruments.put({
    id: expiredId, instrumentNo: 'WTC-OLD', name: '过检仪', maker: 'X', status: '在用',
    location: '', certVersion: 1, createdAt: Date.now(),
    calibrations: [{ calibratedAt: Date.now() - 200 * 86400000, certNo: 'C', certOrg: '', validUntil: Date.now() - 86400000, result: '合格' }],
  });
  await assert.rejects(
    () => booking.reserveSlot({ instrumentId: expiredId, clockId, startAt: t0, endAt: t1, purpose: '走时测试' }),
    /到期/,
  );
  console.log('✓ 过检仪器预约被拒绝');

  // 13) 时段跨越有效期截止的预约被拒绝
  const edgeId = 'ins_edge';
  await db.instruments.put({
    id: edgeId, instrumentNo: 'WTC-EDGE', name: '临界仪', maker: 'X', status: '在用',
    location: '', certVersion: 1, createdAt: Date.now(),
    calibrations: [{ calibratedAt: Date.now(), certNo: 'CE', certOrg: '', validUntil: t0 + 1800000, result: '合格' }],
  });
  await assert.rejects(
    () => booking.reserveSlot({ instrumentId: edgeId, clockId, startAt: t0, endAt: t1, purpose: '走时测试' }),
    /不能覆盖/,
  );
  console.log('✓ 检定有效期不能覆盖整个预约时段时被拒绝');

  // 14) 补检后复测确认，新测试凭证恢复有效，完工可恢复
  const rt0 = t2 + 3 * 3600000;
  const rsvC = await booking.reserveSlot({ instrumentId, clockId, startAt: rt0, endAt: rt0 + 3600000, purpose: '走时测试' });
  const retest = await booking.completeReservationWithTest(draft(clockId), rsvC.id);
  const finalInstruments = await db.instruments.toArray();
  assert.equal(testTypes.testEvidenceOf(retest, finalInstruments), 'valid');
  assert.equal(testTypes.isPassingTest(retest, 'valid'), true);
  console.log('✓ 复测确认后凭证有效，可恢复完工结论');

  await db.delete();
  console.log('\n全部 14 项核心规则通过');
}

main().catch((err) => {
  console.error('测试失败：', err);
  process.exit(1);
});
