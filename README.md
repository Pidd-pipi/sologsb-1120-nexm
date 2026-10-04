# sologsb-1120 古钟表维修工序档案（gbclockrepair）

面向钟表修复师的工序档案台：为一台古董钟表建档，记录机芯型号、零件缺失与配换、拆解顺序、清洗润滑点位，以及修复后的走时测试数据。纯前端单页应用，数据全部保存在浏览器本地。

## Docker 一键启动（推荐）

```bash
cp .env.example .env
docker compose up -d --build
```

访问地址：**http://localhost:21820**

停止服务：

```bash
docker compose down
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | Vue 3 + TypeScript（`<script setup>`） |
| UI | Element Plus 2 |
| 构建 | Vite 5 |
| 状态管理 | Pinia |
| 路由 | Vue Router 4（history 模式） |
| 本地存储 | IndexedDB（Dexie 4），含结构版本号与升级迁移 |
## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:5173
npm run build    # vue-tsc 类型检查 + vite 构建
```

> 生产环境由 nginx 托管 `dist`，`nginx.conf` 已启用 `try_files $uri $uri/ /index.html;` 与 gzip。

## 目录结构

```
sologsb-1120/
├── docker-compose.yml
├── .env.example
├── .env
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf
    ├── index.html
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── public/favicon.svg
    └── src/
        ├── main.ts
        ├── App.vue
        ├── router/index.ts
        ├── types/{clock,part,step,test,instrument,reservation}.ts
        ├── stores/{clock,part,step,instrument}Store.ts
        ├── components/common/{StepSequence,RateChart,ClockCard,StateBadge}.vue
        ├── hooks/{useClockSearch,useRepairProgress,useClockCompletion}.ts
        ├── pages/{ClockList,ClockDetail,StepForm,PartList,InstrumentList,TestView}.vue
        └── utils/{db,timeCalc,id,session,booking}.ts
```

## 页面与路由

| 路由 | 页面 | 消费模型 |
| --- | --- | --- |
| `/clocks` | 钟表台账：按种类/机芯/品相/年代区间筛选，按修复状态分栏 | Clock |
| `/clocks/:id` | 钟表详情：左侧机芯信息，右侧工序流与走时测试记录，可切零件清单 | Clock、RepairStep、TimekeepingTest、MovementPart、CalibrationInstrument |
| `/steps/new` | 新建维修工序：选步骤类型后动态出清洗液/油脂/力矩字段，顺序号冲突即报错 | RepairStep、MovementPart |
| `/parts` | 零件与配换清单：按磨损状态分组，标出待修配条目与来源批号 | MovementPart |
| `/instruments` | 仪器台账：校表仪登记/停用、补检、改检定有效期，查时段占用与待补证测试 | CalibrationInstrument、InstrumentReservation、TimekeepingTest |
| `/tests/:clockId` | 走时测试：测前选在检定有效期内的在用仪器并预约时段，录入多方位读数 | TimekeepingTest、CalibrationInstrument、InstrumentReservation |

`/` 重定向到 `/clocks`，未匹配路由同样兜底到 `/clocks`。

## 数据存储说明

- 数据库名 `gbclockrepair`，当前结构版本 **v3**（`localStorage['gbclockrepair:db-version']` 记录）。
- 六张表：`clocks`（钟表）、`parts`（机芯零件）、`steps`（维修工序）、`tests`（走时测试）、`instruments`（校表仪台账）、`reservations`（仪器时段预约）。
- v1 → v2 迁移：补齐老记录的 `state`、`partIds`、`torque`、`positions` 字段并新增索引。
- v2 → v3：新增仪器与预约两张表；测试凭证由 `instrumentRef` 快照动态判定，老测试无需迁移，自动列为「待补证」。
- 容器无状态、不挂载命名卷；清空站点数据即回到初始示范数据。
- 首次打开灌入 2 台示范钟表、3 项零件、3 道工序、3 台校表仪与 1 次**无仪器记录的旧走时测试**（演示待补证）。

## 仪器、预约与完工口径

- **测前必选仪器**：保存测试前必须选择「在用 + 检定在有效期内」的校表仪并预约时段；停用、过检、有效期不能覆盖整个时段或时段冲突，一律拒绝保存。
- **跨页签互斥**：预约与保存都在单个 IndexedDB 读写事务内完成（先回收心跳超时项，再查重、再写入），两个页签抢同一台仪器同一时段只有一人成功。
- **中断不占坑**：预约持有期间每 5s 心跳续约（TTL 15s）；取消、切换钟表、路由离开、关闭页签立即释放，崩溃残留由 TTL 与台账「回收中断超时预约」兜底。
- **仪器变动即失效**：补检、停用、改检定有效期都会使仪器 `certVersion +1`，引用该仪器的历史测试立即失效；钟表「已完成」结论同步撤下，用有效期内仪器复测确认合格后恢复。
- **旧测试待补证**：没有仪器记录（或仪器已删除）的旧测试一律列入「待补证」，不沿用原合格结果，必须复测。
- 凭证规则可本地验证：`npx tsx scripts/booking.test.ts`（需 `fake-indexeddb`、`tsx`，仅开发期使用）。

## 功能要点

- **顺序号不跳号**：新建工序时若顺序号大于「当前最大顺序号 + 1」直接报错并给出建议值；`<StepSequence>` 对缺口行标红。
- **工序排序**：支持「上移 / 下移」按钮与原生拖拽交换顺序，交换的是 `seq`。
- **工序完成 / 回退**：完成后写 `finishedAt`，回退后计入待办与回退计数。
- **双轴走时图**：`<RateChart>` 左轴日差 s/d、右轴摆幅 °，标注四方位读数与均值。
- **走时单导出**：按方位均值生成文本，可复制或下载 txt。
