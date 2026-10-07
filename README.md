# 厂内检修断电挂牌演练系统（Lockout / Tagout Drill）

一个基于 **Node.js + SQLite + 浏览器界面** 的检修断电挂牌（LOTO）演练 Web 应用。
管理员维护电源、开关与设备的有向供电关系；操作员执行“分闸 → 挂牌 / 解牌 → 合闸”
和检修许可的申请、结束；系统按供电路径自动判定设备是否真正断电隔离，
并用全局修订号实现多人并发控制，记录每次成功变更的前后状态。

## 功能与业务规则

### 角色
- **管理员（admin）**：维护供电网络 —— 新增 / 删除 / 重命名电源、开关、设备，
  启用 / 停用电源，架设或拆除有向供电关系（边）。
- **操作员（operator）**：开关分闸、合闸、挂牌、解牌；为设备申请 / 结束检修许可；
  编排并执行**临时操作单**（分闸 → 挂牌 → 申请许可的有序成套操作，支持预演）。

### 开关状态机
1. 合闸位置的开关必须先 **分闸（open）** 才能 **挂牌（tag）**；
2. **挂牌开关不得合闸**：对挂牌开关执行合闸直接拒绝（`SWITCH_TAGGED`）；
3. 解牌（untag）后才允许重新合闸。

### 许可生效条件
- 从 **所有 `enabled=1` 的启用电源** 出发，沿有向供电边到达目标设备的全部路径，
  都必须经过至少一个 **已挂牌开关**（路径在挂牌点被视为切断）。
- 申请时若仍存在未切断路径，返回 `422 PERMIT_NOT_ISOLATED`，并列出未切断
  路径（节点链），界面同步高亮，便于学员找到还需挂牌的开关。
- 停用电源视为无输出，不产生路径；**没有任何启用电源，或所有通路都被挂牌
  切断时，许可仍可正常申请**。

#### 隔离判定与路径枚举分离（枚举触顶不再漏判）
早期版本把“路径枚举”直接当作“隔离判定”：枚举限制每个电源最多收集 200 条
支路、单条路径最多 64 个节点。若同一启用电源的前 200 条支路恰好都在挂牌
开关处被截断、其后仍有支路直达设备，枚举触顶会漏掉带电路径，导致**实际带电
却误判已隔离、许可误生效**。

修复后两者彻底分离：

- **隔离判定走完整可达性分析**（多源 BFS，挂牌开关为不可穿过的屏障），
  **不设数量或长度上限**。申请许可，以及有效许可期间的解牌、启用电源、
  改线（节点/接线）保护，全部以该完整分析为准；任何“枚举未知”都不会被
  当作“已隔离”，存在未切断通路即拒绝。
- **路径枚举仅用于诊断展示**，仍保留数量/长度上限（未切断路径 200 条、
  被挂牌切断路径 200 条、单条 64 节点），但：
  - 未切断与被挂牌切断两类路径**分别计数**，互不挤占名额（再多重叠的挂牌
    支路也不会挤掉带电路径）；
  - 触顶时响应与界面显式返回/显示 `truncated` 截断标记（数量触顶
    `countLimited`、超长触顶 `lengthLimited`，并附上限值）；
  - 因超长未枚举出任何带电路径时，系统会用可达性分析的 **BFS 见证路径**
    补入一条真实带电路径（允许超过展示长度上限）。
- **拒绝响应保证至少返回一条实际带电路径**：申请失败的 `livePaths` 与
  `ISOLATION_VIOLATION` 中每个受影响许可的 `livePaths` 至少含 1 条真实
  未切断路径，浏览器在拒绝提示中展示拒绝原因、该路径及截断说明。

### 许可有效期内的“整体拒绝”
任一有效许可存续期间，下列变更若会使该许可不再满足隔离条件，**整次操作拒绝、
数据库事务回滚、状态与修订号均不变**，并返回受影响许可与重新来电的路径：
- 对挂牌开关 **解牌**（或给挂牌开关合闸）；
- **启用电源**（例如把带旁路的停用电源重新启用）；
- **改动线路 / 节点**（新增绕过挂牌点的接线等）。

> 说明：删除节点或拆除接线只会减少通路，不可能创造新的来电回路，因此这类操作
> 天然不会破坏隔离；删除挂有有效许可的设备本身仍被禁止，需先结束许可。
>
> 边界：上述保护与许可申请共用同一套**完整可达性分析**，不受诊断枚举的
> 200 条 / 64 节点上限影响——即使供电路径数量极多或极长，只要存在一条
> 未切断通路，操作就会被整体拒绝并回滚；拒绝体中的 `truncated` 仅说明
> 附带展示的路径列表被限量截断，不代表隔离结论不确定。

### 临时操作单（编排 — 预演 — 确认）
检修前常需依次“分闸、挂牌并申请许可”。操作员可在浏览器“临时操作单”页（或调用
HTTP API）临时编排一张操作单：

- 步骤按序填写：开关编号 + 动作（`open` 分闸、`tag` 挂牌、`untag` 解牌、
  `close` 合闸），**末步**可填写设备编号执行一次 `permit` 申请许可（许可步只能是
  最后一步；一张单子至多一个许可步）。
- **预演**（`POST /api/orders/preview`）纯只读：展示每一步的动作、前后开关状态、
  成功 / 失败 / 未执行、失败原因；若末步申请许可，同时展示目标设备**当前**隔离
  状态与“按本单前面步骤执行后”的隔离结论。预演**不改变真实网络、有效许可、
  修订号或审计**，响应携带所依据的当前 `revision`。
- **确认**（`POST /api/orders/confirm`）在 `IMMEDIATE` 事务、修订号校验通过后按
  **原顺序原子执行**：每一步都遵守现有开关状态机与有效许可隔离保护；
  **不允许用后续步骤补救前一步违规**——任一步失败即在该步中止，响应返回
  **步骤序号 `step`**、动作名与原因（错误码沿用 `SWITCH_TAGGED`、
  `SWITCH_NOT_OPEN`、`INVALID_STATE`、`ISOLATION_VIOLATION`、
  `PERMIT_NOT_ISOLATED` 等），隔离失败附**实际带电路径**（`livePaths` /
  `violations[].livePaths`）与截断标记，整单回滚、**不落库**（修订号、审计均不变）。
- 确认沿用现有 `actor` / `role`（仅 `operator`）/ `revision` 及 `STALE_REVISION`
  约定：预演后若版本被他人改变，确认返回 `409` 与**当前完整状态**，核对后重试；
  成功时整单**只递增一次修订号**，审计只写**一条** `order.confirm` 记录，
  `detail.steps` 为有序执行清单，`state_before` / `state_after` 为整单前后完整快照。
- 操作单本身是浏览器 / 请求里的临时编排，**不建表、不落库**。

### 隔离建议（最少新增挂牌）
操作员在“供电网络”页选择设备后可查看**基于当前修订号**的隔离建议，也可直接调用
`GET /api/devices/:id/isolation-advice`。系统在**所有启用电源到设备的完整供电图**上
求解“使设备断电所需**新增挂牌开关数最少**的一组开关”：

- **已挂牌开关视作屏障**（代价为 0，不计入新增）；问题被建模为有向图**最小顶点割**
  （割项只允许是未挂牌开关），用拆点 + Dinic 最大流精确求解，**不依赖有数量 / 长度
  上限的诊断路径枚举**，环路、超长图同样适用。
- 结果给出建议挂牌的开关，以及**按各开关当前状态**生成的步骤：合闸位置的开关
  **先分闸（open）再挂牌（tag）**，已分闸的只出挂牌步；步骤可直接作为临时操作单
  步骤带入预演 / 确认。
- **设备已隔离**（无启用电源，或所有通路已被挂牌切断）时返回 `isolated:true` 与
  **空步骤**。
- **不可行**：若存在一条**不经过任何开关**的来电通路（例如电源直接接线到设备、
  或无开关旁路），挂牌无法切断它，返回 `422 ISOLATION_INFEASIBLE` 与一条真实
  带电路径（完整可达性分析给出，非限量枚举）。
- **修订号约定**：建议响应携带所依据的 `revision`，步骤带入操作单后，**确认必须使用
  该 revision**；建议生成之后网络或开关状态被他人改变，确认按既有约定返回
  `409 STALE_REVISION` 与当前完整状态，界面把原建议标记为 **STALE**，
  **不自动改用新方案**，需操作员显式重新获取。
- **步数上限**：建议步骤数按现有操作单上限（200 步）给出 `withinOrderLimit`；
  超限时**明确“不可整单执行”**，但全部步骤仍完整返回、**不截断**，界面禁用
  预演 / 确认按钮。
- 建议接口为**只读**：不校验角色、不改变修订号与审计；既有的角色、逐步状态机、
  事务回滚与审计约定全部继续适用（确认仍走 `/api/orders/confirm`）。

### 有效许可的单点挂牌失效风险
操作员可查看**每张有效许可的隔离是否单独依赖某一块挂牌**（单点失效风险）：

- `POST /api/permits/tag-risk`（只读）对**每个当前已挂牌开关**分别假设其挂牌失效
  （不再阻断供电），其余开关状态与供电图保持原状，按与许可生效判定相同的
  **完整可达性规则**判断哪些有效许可会重新出现未切断通路。
- 可选 `permit_ids` 筛选要检查的许可；**省略时检查全部有效许可**。显式空组、
  重复编号、非正整数返回 `400`，引用不存在或已结束的许可编号返回 `404`。
- 结果按**开关编号、许可编号稳定排序**；每项风险附**一条真实带电路径**
  （完整可达性分析的 BFS 见证路径，**不受诊断路径 200 条 / 64 节点展示上限影响**）。
- **未影响任何所查许可的已挂牌开关也须列出**（`risks` 为空，标记无单点风险）；
  **没有有效许可时返回空报告**（`switches` 为空）。
- 整份报告基于**同一次当前状态快照**（同一读事务）并携带 `revision`；
  报告**只读**：不校验角色、不改变开关、许可、修订号或审计。
- 浏览器在“检修许可”页的“单点挂牌失效风险”面板中可勾选要检查的许可
  （默认全部）、生成报告，并点击任一带电路径在供电网络图中高亮。

### 多设备协同隔离与整组许可
同一检修班组一次为多台设备取得许可时，操作员可按**设备编号集合**请求协同隔离方案：

- `device_ids` 必须是非空数组、编号为正整数且**无重复**；空集合、非数字编号、重复
  编号返回 `400`，引用不存在的编号或把开关编号误作设备返回 `404`。
- `POST /api/isolation-group/plan` 是只读方案接口，基于所有启用电源、完整有向供电图
  和已有挂牌屏障，求使集合内**所有目标设备断电**的“新增挂牌开关总数最少”方案。
  已挂牌开关为零成本屏障；开关若处在多个目标的供电路径上，会在
  `sharedSwitchIds` 中标记为共用开关，只需分闸 / 挂牌一次。
- 已隔离目标不产生开关步骤；响应分别给出 `stepCount`（必要分闸挂牌步数）、
  `permitCount`（目标许可数）和 `confirmationStepCount`（确认时总步数）。
- 任一目标存在不经过任何开关的带电通路时，整组判为不可行，返回
  `422 ISOLATION_INFEASIBLE`、所有不可行目标及其真实通路
  （`infeasibleDevices[].livePath`，并提供首条 `livePath` 兼容单设备读法）。
- `POST /api/isolation-group/preview` 由服务器按当前状态重新计算并纯内存预演全部
  开关步骤和每张许可；只读、不推进修订号、不写审计。超过 200 步时仍完整预演展示。
- `POST /api/isolation-group/confirm` 必须携带方案所据 `revision`，服务器重新校验
  编号集合、重算方案，并在一个 `IMMEDIATE` 事务中执行：必要分闸挂牌 → 为每个目标
  顺序创建许可。每步继续遵守现有开关状态机和有效许可隔离保护；每台设备仍只允许
  一张有效许可。任一步或许可失败均整组回滚，不留半完成状态。
- 成功时只推进一次修订号，只写一条 `isolationGroup.confirm` 审计，审计含设备集合、
  新增挂牌数、总步数、有序步骤结果以及前后完整状态。修订号过期返回
  `409 STALE_REVISION` 和当前完整状态，不自动改用新方案。
- 当 `confirmationStepCount` 超过现有操作单 200 步上限时，方案和预演仍完整展示，
  `withinOrderLimit:false`；整组确认返回 `400 STEPS_TOO_LONG`，不可部分执行。
- 旧的单设备建议、临时操作单和许可接口路径与行为保持兼容；新接口是叠加能力。

### 多人并发（乐观锁）
- 每次成功变更都会让全局 **修订号 revision + 1**（界面右上角实时显示）。
- 所有写操作必须携带操作者“所见”的 `revision`。
- 提交时若库中修订号已不同，返回 `409 STALE_REVISION` 与 **当前完整状态**，
  前端自动刷新为最新状态，要求核对后重试；过期提交不会落库。

### 审计
每次成功变更记录：时间（UTC）、操作者、角色、动作、参数、
变更前后修订号以及 **变更前后完整网络状态快照**（JSON）。

## 技术栈
- 后端：Node.js + Express
- 存储：SQLite（better-sqlite3，WAL 模式，写操作使用 `IMMEDIATE` 事务）
- 前端：原生 HTML/CSS/JS（无构建步骤），SVG 供电网络图、路径高亮
- 部署：多阶段 Dockerfile + Docker Compose（构建镜像、安装依赖、建库、启动）

## 快速开始（Docker Compose，推荐）

```bash
# 构建镜像 + 安装依赖 + 初始化数据库(空库自动写入演示网络) + 启动
docker compose up -d --build

# 查看日志
docker compose logs -f

# 停止
docker compose stop

# 停止并删除容器(数据保留在卷 loto_loto-data 中)
docker compose down

# 连同数据卷一并清空(恢复初始演示网络)
docker compose down -v
```

访问地址：**http://localhost:3000**
（如修改端口见下文配置）。容器启动命令为
`npm run init-db && node server.js`，即 **先建库后启动**；重复执行安全，
已有数据时初始化脚本只建表、不覆盖数据。

## 本地直接运行（Node 20+）

```bash
npm install          # 安装依赖
npm run init-db      # 建库 + 演示数据(默认 data/loto.db)
npm start            # 启动服务, 默认 http://localhost:3000
```

## 配置

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 应用监听端口（容器内） |
| `LOTO_DB` | `data/loto.db`（项目目录下） | SQLite 数据库文件路径 |
| `LOTO_PORT` | `3000` | **仅 Compose 使用**：宿主机映射端口，即浏览器访问端口 |

修改访问端口示例：

```bash
# 方式一：环境变量
LOTO_PORT=8080 docker compose up -d --build
# 访问 http://localhost:8080

# 方式二：复制 .env.example 为 .env 后修改 LOTO_PORT
cp .env.example .env
```

数据持久化：Compose 使用命名卷 `loto-data` 挂载到容器 `/app/data`。
重置为初始演示网络：`docker compose down -v && docker compose up -d --build`。

## 浏览器操作指引
1. 右上角填写 **操作者姓名**，选择身份（操作员 / 管理员），身份保存在浏览器本地。
2. **供电网络** 页：点击节点，右侧出现该节点可执行操作；
   - 电源：管理员可启用 / 停用；
   - 开关：操作员可分闸、合闸、挂牌、解牌（图中红色虚边为被挂牌切断的线路）；
   - 设备：操作员可申请许可，或“查看供电路径”（未切断路径橙色高亮）。
3. **临时操作单** 页（操作员）：选择动作与目标逐行加入步骤（可上下移动 / 删除）；
   点“预演”可反复演练，右侧展示各步前后状态、成功/失败/未执行与目标设备当前及
   按单推演后的隔离状态，真实状态不变；预演通过后点“确认执行”，整单原子落库、
   修订号 +1；若预演后他人已提交，确认会收到 `409 STALE_REVISION` 并自动刷新。
   也可在“供电网络”页点设备 →“隔离建议（最少挂牌）”，系统基于当前修订号算出
   最少新增挂牌的开关与“先分闸、再挂牌”步骤并载入操作单；已隔离时建议为空步骤，
   存在无开关来电通路时提示不可行并高亮该路径；建议面板显示所依据修订号，确认
   必须使用该修订号，期间他人提交后面板标记 STALE 且不会自动改用新方案；
   步骤超过单据上限时明确提示不可整单执行（步骤不截断、按钮禁用）。
4. **检修许可** 页：选择设备申请许可；申请失败时弹窗列出至少一条未切断路径；
   路径数量 / 长度超过诊断上限时，弹窗与许可卡片会用黄色提示标记“仅展示部分
   路径”，但拒绝结论基于完整可达性分析，不受上限影响。有效许可卡片实时显示
   隔离是否满足，可随时结束许可。页面下方的“单点挂牌失效风险”面板可勾选要
   检查的许可（默认全部）并生成报告：逐已挂牌开关假设其挂牌失效，红色条目
   列出将失去隔离的许可与一条真实带电路径（点击可在网络图中高亮），绿色
   条目为无单点风险的开关；报告携带所依据修订号，只读不改状态。
5. **拓扑管理** 页（管理员）：维护节点和有向供电关系。
   规则：电源只能作起点、设备只能作终点、不允许自环和重复接线。
6. **变更记录** 页：查看所有成功变更的时间、操作者、动作、前后修订号，
   可展开查看前后完整状态快照。
6. 页面每 10 秒轮询一次修订号；他人提交后会自动刷新。若你的提交过期，
   会收到明确提示并刷新到最新状态。

### 演示网络
初始库内置：`1#主电源 → K1 → K3 → 1#循环水泵`，
`2#备用电源 → K2 → K3 → 1#循环水泵`，以及 `K1 → 2#引风机`。
建议演练流程：
1. 直接对“1#循环水泵”申请许可 → 失败，显示两条未切断路径；
2. K1 分闸 → 挂牌；K2 分闸 → 挂牌；
3. 再申请许可 → 生效；
4. 尝试给 K1/K2 解牌或让管理员架旁路 → 被整体拒绝并显示来电路径；
5. 结束许可后再解牌恢复送电。

## HTTP API 摘要

所有确认 / 变更操作均需 JSON body：`actor`（姓名）、`role`
（`admin`/`operator`）、`revision`（所见修订号）。只读方案 / 状态接口无需这些字段；
协同预演为只读，但按操作单约定仍需 `actor` 与 `role:operator`。

| 方法 | 路径 | 角色 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/state` | - | 当前完整状态（修订号、节点、边、有效许可、隔离判定与 `truncated` 诊断截断标记） |
| GET | `/api/health` | - | 健康检查 |
| GET | `/api/devices/:id/paths` | - | 设备供电路径诊断（限量展示未切断 / 被挂牌切断路径，触顶时 `truncated` 标记截断；`isolated` 以完整可达性分析为准） |
| GET | `/api/devices/:id/isolation-advice` | - | **隔离建议**（只读）：基于当前修订号求最少新增挂牌开关与先分闸再挂牌步骤；已隔离返回空步骤；无开关来电通路返回 `422 ISOLATION_INFEASIBLE` + 真实带电路径；超步数上限时 `withinOrderLimit:false` 且步骤不截断 |
| POST | `/api/permits/tag-risk` | - | **单点挂牌失效风险报告**（只读）`{permit_ids?:[...]}`：逐挂牌开关假设失效后检查有效许可的未切断通路，附真实带电路径；省略 `permit_ids` 检查全部有效许可 |
| POST | `/api/isolation-group/plan` | - | **多设备协同方案**（只读）`{device_ids:[...]}`：返回共用开关、必要分闸挂牌步骤、许可数、总步数和所据修订号；任一目标无开关可切断时 `422` |
| POST | `/api/isolation-group/preview` | operator | 多设备协同方案**预演**（只读，不校验/改变修订号）`{device_ids:[...]}` |
| POST | `/api/isolation-group/confirm` | operator | 多设备协同隔离与全部许可**一次确认**（原子，revision +1，一条审计）`{device_ids:[...]}` |
| GET | `/api/audit?limit=100` | - | 变更记录（含前后状态快照） |
| POST | `/api/admin/nodes` | admin | 新增节点 `{kind, name}` |
| PATCH | `/api/admin/nodes/:id` | admin | 改名 / 启用停用电源 `{name?, enabled?}` |
| DELETE | `/api/admin/nodes/:id` | admin | 删除节点（级联删除相关边） |
| POST | `/api/admin/edges` | admin | 新增供电关系 `{from_node, to_node}` |
| DELETE | `/api/admin/edges/:id` | admin | 拆除供电关系 |
| POST | `/api/switches/:id/open` | operator | 分闸 |
| POST | `/api/switches/:id/close` | operator | 合闸（挂牌时拒绝） |
| POST | `/api/switches/:id/tag` | operator | 挂牌（须先分闸） |
| POST | `/api/switches/:id/untag` | operator | 解牌（破坏有效许可隔离时拒绝） |
| POST | `/api/permits` | operator | 申请许可 `{device_id}` |
| POST | `/api/permits/:id/end` | operator | 结束许可 |
| POST | `/api/orders/preview` | operator | 临时操作单**预演**（只读，不校验/改变修订号）`{steps:[...]}` |
| POST | `/api/orders/confirm` | operator | 临时操作单**确认执行**（原子，revision +1）`{steps:[...]}` |

错误约定：`400` 参数错误 / `403` 角色不允许 / `404` 不存在 /
`409 STALE_REVISION` 修订号过期（响应含 `current` 当前状态）/
`422` 业务规则不满足（如 `PERMIT_NOT_ISOLATED`、`ISOLATION_VIOLATION`、
`SWITCH_TAGGED`，响应中携带未切断路径）。

拒绝隔离类错误（`PERMIT_NOT_ISOLATED` 及 `ISOLATION_VIOLATION` 的每个
`violations[]`）响应体额外包含：

- `livePaths`：**至少一条**实际未切断供电路径（节点链 / 边链；极端超长
  场景由 BFS 见证路径补足，可超过展示长度上限）；
- `truncated`：诊断列表截断标记
  `{ live:{countLimited,lengthLimited,limit,maxLength},
  blocked:{...} }`，仅表示附带展示被限量，不影响拒绝结论。
`/api/state` 中每个有效许可的 `isolation`、`/api/devices/:id/paths`
同样携带 `truncated`。接口路径、请求字段、错误码、角色校验、revision
冲突处理、事务回滚与审计快照约定均保持不变。

#### 临时操作单 API 示例

步骤对象：开关步 `{"action":"open|tag|untag|close","node_id":3}`；
许可步（仅末步）`{"action":"permit","device_id":6}`。

```bash
# 1) 预演: 分闸 K1→挂牌 K1→分闸 K2→挂牌 K2→为 1#循环水泵 申请许可
curl -s -X POST http://localhost:3000/api/orders/preview \
  -H 'Content-Type: application/json' \
  -d '{
    "actor": "张三", "role": "operator", "revision": 1,
    "steps": [
      {"action":"open","node_id":3}, {"action":"tag","node_id":3},
      {"action":"open","node_id":4}, {"action":"tag","node_id":4},
      {"action":"permit","device_id":6}
    ]
  }'
# -> { ok:true, kind:"order.preview", revision:1, success:true, failedStep:null,
#      steps:[ {step:1,action:"open",ok:true,before:{open_pos:false,tagged:false},
#               after:{open_pos:true,tagged:false},message:"分闸完成（分闸）"},
#              ...,
#              {step:5,action:"permit",ok:true,isolation:{isolated:true,...}} ],
#      permitIsolation:{ device_id:6, device_name:"1#循环水泵", isolated:false,
#                        livePaths:[...] } }   # 目标设备“当前”隔离状态(执行前)
# 预演不写任何数据; failedStep 非空时该步含 error, 其后各步 skipped:true。

# 2) 确认执行: 携带所见 revision; 成功整单只 +1 并写一条 order.confirm 审计
curl -s -X POST http://localhost:3000/api/orders/confirm \
  -H 'Content-Type: application/json' \
  -d '{
    "actor": "张三", "role": "operator", "revision": 1,
    "steps": [
      {"action":"open","node_id":3}, {"action":"tag","node_id":3},
      {"action":"open","node_id":4}, {"action":"tag","node_id":4},
      {"action":"permit","device_id":6}
    ]
  }'
# -> 200 { ok:true, action:"order.confirm",
#         steps:[{step:1,action:"open",node_id:3}, ...,
#                {step:5,action:"permit",device_id:6,permit_id:1}],
#         permit_id:1, revision:2, snapshot:{...当前完整状态...} }
#
# 任一步失败 -> 422 { ok:false, step:3, step_name:"挂牌",
#                     error:{code:"SWITCH_NOT_OPEN",message:"第 3 步执行失败: ..."},
#                     step_results:[...各步结果...],
#                     livePaths|violations:[...实际带电路径...], truncated:{...} }
# 整单回滚不落库; 修订号过期 -> 409 STALE_REVISION + current(当前完整状态)。
```

预演请求也需带 `actor` 与 `role:operator`（仅做身份展示与鉴权），但 `revision`
不参与校验——预演永远基于当前状态推演。

#### 隔离建议 API 示例

```bash
# 1) 获取设备 6(1#循环水泵)基于当前修订号的最少新增挂牌建议(只读, 无需 revision/角色)
curl -s http://localhost:3000/api/devices/6/isolation-advice
# -> 200 { ok:true, kind:"device.isolationAdvice", revision:1,
#         device_id:6, device_name:"1#循环水泵", feasible:true, isolated:false,
#         newTagCount:1,
#         switches:[{node_id:5,name:"联络开关K3",open_pos:false,tagged:false}],
#         steps:[{action:"open",node_id:5},{action:"tag",node_id:5}],  # 先分闸再挂牌
#         stepCount:2, withinOrderLimit:true, orderMaxSteps:200 }
# 演示网络中两路电源在 K3 汇合, 只需新增挂牌 K3(1 个)即可同时切断两路,
# 优于分别挂 K1、K2(2 个)。

# 2) 已隔离 -> 空步骤
# -> 200 { ..., feasible:true, isolated:true, switches:[], steps:[],
#          stepCount:0, newTagCount:0 }

# 3) 存在不经过开关的来电通路 -> 422 不可行 + 一条真实带电路径
# -> 422 { ok:false, error:{code:"ISOLATION_INFEASIBLE",message:"..."},
#          revision:7, device_id:7, feasible:false, isolated:false,
#          livePath:{nodes:[{id:1,kind:"source",name:"1#主电源"},
#                           {id:7,kind:"device",name:"2#引风机"}], edges:[12]},
#          livePaths:[ ...同上 ] }

# 4) 把建议 steps 直接带入操作单预演(只读, revision 不校验)
curl -s -X POST http://localhost:3000/api/orders/preview \
  -H 'Content-Type: application/json' \
  -d '{"actor":"张三","role":"operator","revision":1,
       "steps":[{"action":"open","node_id":5},{"action":"tag","node_id":5}]}'

# 5) 确认必须使用建议所依据的 revision(本例 1); 期间被他人改动 -> 409 STALE_REVISION
curl -s -X POST http://localhost:3000/api/orders/confirm \
  -H 'Content-Type: application/json' \
  -d '{"actor":"张三","role":"operator","revision":1,
       "steps":[{"action":"open","node_id":5},{"action":"tag","node_id":5}]}'
# -> 200 { ok:true, action:"order.confirm", revision:2, steps:[...], snapshot:{...} }
# 409 时 body.current 为当前完整状态; 客户端沿用 STALE_REVISION 处理, 不自动改用新方案。

# 6) 建议所需步骤超过操作单上限(200)时: 明确不可整单执行, 步骤全量返回不截断
# -> 200 { ..., feasible:true, stepCount:402, withinOrderLimit:false,
#          orderMaxSteps:200, steps:[ ...402 项, 未截断... ] }
```

浏览器中的用法：在“供电网络”页点击设备 →“隔离建议（最少挂牌）”，自动跳转到
“临时操作单”页展示建议面板（建议挂牌开关、步骤数、所依据修订号）；点
“载入操作单预演 / 确认”即用建议步骤替换当前编排，随后照常预演、确认。
若期间修订号被他人推进，建议面板出现黄色 **STALE** 提示并禁用确认，
需“清除建议”后对当前状态重新获取——系统不会自动套用新方案。

#### 单点挂牌失效风险报告 API 示例

```bash
# 1) 检查全部有效许可(省略 permit_ids); 只读, 无需 actor/role/revision
curl -s -X POST http://localhost:3000/api/permits/tag-risk \
  -H 'Content-Type: application/json' -d '{}'
# -> 200 { ok:true, kind:"permit.tagRisk", revision:6,
#         permit_ids:[1], permits:[{permit_id:1,device_id:6,device_name:"1#循环水泵"}],
#         taggedSwitchCount:2, riskCount:2,
#         switches:[
#           { switch_id:3, name:"进线开关K1", risks:[
#             { permit_id:1, device_id:6, device_name:"1#循环水泵",
#               livePath:{ nodes:[{id:1,...,"1#主电源"},{id:3,...},{id:5,...},{id:6,...}],
#                          edges:[1,3,5] } } ] },   # 假设 K1 挂牌失效后的真实带电路径
#           { switch_id:4, name:"备用开关K2", risks:[ ... ] } ] }
# 已挂牌但不影响任何所查许可的开关同样列出: { switch_id:5, name:"联络开关K3", risks:[] }

# 2) 只检查指定许可(可多个, 顺序无关, 结果按许可编号排序)
curl -s -X POST http://localhost:3000/api/permits/tag-risk \
  -H 'Content-Type: application/json' -d '{"permit_ids":[2,1]}'

# 3) 无有效许可时 -> 空报告
# -> 200 { ok:true, kind:"permit.tagRisk", revision:1,
#         permit_ids:[], permits:[], taggedSwitchCount:0, riskCount:0, switches:[] }

# 4) 筛选参数校验
#    {"permit_ids":[]}      -> 400 PERMIT_IDS_REQUIRED  (显式空组)
#    {"permit_ids":[1,1]}   -> 400 PERMIT_IDS_DUPLICATE (重复)
#    {"permit_ids":[0]}     -> 400 INVALID_PERMIT_ID    (非正整数)
#    {"permit_ids":[999]}   -> 404 PERMIT_NOT_FOUND     (不存在或已结束的许可)
# 报告为只读: 响应前后修订号、开关状态、许可与审计均不变。
```

浏览器中的用法：进入“检修许可”页的“单点挂牌失效风险”面板，默认检查全部
有效许可，也可取消勾选只看部分许可；点击“生成风险报告”后按开关列出结论——
红色卡片为该开关挂牌失效后将失去隔离的许可及一条真实带电路径（点击路径可在
“供电网络”图中高亮），绿色卡片为无单点风险的开关。报告标注所依据的修订号；
状态被他人推进后面板会提示报告已过期，需重新生成。

#### 多设备协同隔离 API 示例

```bash
# 1) 查看设备 6、7 的协同方案(只读): device_ids 必须非空且无重复
curl -s -X POST http://localhost:3000/api/isolation-group/plan \
  -H 'Content-Type: application/json' \
  -d '{"device_ids":[6,7]}'
# -> 200 {
#   ok:true, kind:"isolationGroup.plan", revision:1,
#   device_ids:[6,7],
#   devices:[{device_id:6,isolated:false,protectedBy:[3,4]},
#            {device_id:7,isolated:false,protectedBy:[3]}],
#   newTagCount:2, sharedSwitchIds:[3],
#   switches:[{node_id:3,name:"进线开关K1",shared:true,...}, ...],
#   steps:[{action:"open",node_id:3},{action:"tag",node_id:3},
#          {action:"open",node_id:4},{action:"tag",node_id:4}],
#   stepCount:4, permitCount:2, confirmationStepCount:6,
#   withinOrderLimit:true, orderMaxSteps:200
# }

# 2) 按当前状态预演全部分闸挂牌步骤和两张许可(只读)
curl -s -X POST http://localhost:3000/api/isolation-group/preview \
  -H 'Content-Type: application/json' \
  -d '{"actor":"张三","role":"operator","revision":1,"device_ids":[6,7]}'
# -> { success:true, revision:1, steps:[...4 个开关步 + 2 个 permit 步...] }

# 3) 凭方案所据 revision 一次确认; 成功仅 revision +1、一条审计
curl -s -X POST http://localhost:3000/api/isolation-group/confirm \
  -H 'Content-Type: application/json' \
  -d '{"actor":"张三","role":"operator","revision":1,"device_ids":[6,7]}'
# -> 200 { ok:true, action:"isolationGroup.confirm", revision:2,
#          device_ids:[6,7], permit_ids:[1,2], steps:[...6 步...],
#          snapshot:{...完整当前状态...} }

# 任一目标有无开关带电通路:
# -> 422 { ok:false, error:{code:"ISOLATION_INFEASIBLE",...},
#          infeasibleDeviceIds:[8],
#          infeasibleDevices:[{device_id:8,device_name:"...",
#            livePath:{nodes:[...真实电源到设备路径, 不经过开关...], edges:[...]}}] }
# 超过 200 步: plan/preview 仍返回完整 steps; confirm -> 400 STEPS_TOO_LONG。
# revision 过期: confirm -> 409 STALE_REVISION + current 当前完整状态。
```

浏览器中的协同用法：进入“临时操作单”页顶部的“多设备协同隔离”，勾选同班组设备，
依次点击“查看协同方案”“按方案预演”“一次确认隔离与全部许可”。方案面板会显示
共用开关、每台目标由哪些新增挂牌点保护、分闸挂牌步数、许可数、确认总步数和所据
修订号；状态被他人推进时旧方案标记为 **STALE**，不会自动替换。

## 目录结构

```
.
├── Dockerfile              # 多阶段构建(编译 better-sqlite3 原生模块)
├── docker-compose.yml      # 构建、init-db 建库、启动、数据卷、健康检查
├── .env.example            # 端口配置示例
├── server.js               # Express 服务与全部 API / 事务 / 并发控制
├── src/
│   ├── db.js               # SQLite 连接、表结构、演示数据
│   ├── graph.js            # 完整可达性隔离判定(无上限) + 限量诊断路径枚举
│   ├── advisor.js          # 单设备/多设备隔离建议: 最小新增挂牌点割(拆点 + Dinic)
│   ├── tagrisk.js          # 单点挂牌失效风险: 逐挂牌开关假设失效的完整可达性分析
│   ├── orders.js           # 临时操作单: 结构校验 + 纯内存预演 + 按序原子提交
│   └── init-db.js          # 建库脚本(npm run init-db)
├── public/                 # 浏览器界面(原生 JS + SVG)
│   ├── index.html
│   ├── app.js
│   └── styles.css
└── test/
    ├── smoke.js            # 端到端业务规则冒烟测试(HTTP)
    ├── orders.e2e.js       # 临时操作单预演/确认/原子回滚/STALE_REVISION 的 HTTP 回归
    ├── advice.e2e.js       # 单设备隔离建议最少挂牌/空步骤/不可行/建议带入单据/409 回归
    ├── group.e2e.js        # 多设备协同方案/预演/一次确认/重复许可/不可行/单审计回归
    ├── advisor.test.js     # 单/多设备隔离建议单元测试(最小割、共用开关、无开关旁路等)
    ├── tagrisk.test.js     # 单点挂牌失效风险单元测试(排序/空报告/超长链见证路径等)
    ├── tagrisk.e2e.js      # 风险报告 HTTP 回归(筛选校验/真实路径/只读/空报告)
    ├── graph.test.js       # 隔离判定单元测试(枚举触顶/超长/环路)
    └── truncation.e2e.js   # 200 条挂牌支路挤掉带电路径的 HTTP 回归(手动)
```

## 测试

```bash
# 单元测试(无需起服务, 无需数据库)
npm run test:graph
npm run test:advisor
npm run test:tagrisk

# 端到端冒烟(终端1 起服务, 终端2 跑测试; 使用独立 DB 避免污染演示库)
LOTO_DB=/tmp/loto-test.db PORT=3100 node server.js
node test/smoke.js

# 临时操作单回归(预演只读/确认原子/逐步失败不可补救/整单回滚/单次修订号/409)
BASE=http://127.0.0.1:3100 node test/orders.e2e.js

# 隔离建议回归(最少新增挂牌/已隔离空步骤/无开关通路 422/建议带入预演确认/409/只读不审计)
BASE=http://127.0.0.1:3100 node test/advice.e2e.js

# 多设备协同回归(集合校验/共用开关/预演只读/整组许可/重复许可拒绝/不可行路径/单审计)
BASE=http://127.0.0.1:3100 node test/group.e2e.js

# 单点挂牌失效风险回归(筛选校验/逐开关假设失效/真实带电路径/只读/空报告)
BASE=http://127.0.0.1:3100 node test/tagrisk.e2e.js

# 枚举触顶回归(同样打到 PORT=3100 的服务; 结束会清理临时拓扑)
node test/truncation.e2e.js
```

也可以按原方式运行：

```bash
npm run init-db && PORT=3100 node server.js   # 终端1
node test/smoke.js                            # 终端2
```

冒烟测试覆盖：路径枚举与申请失败、挂牌合闸互锁、隔离保护整体拒绝与回滚、
乐观锁 409、角色控制、拓扑约束、审计快照等共 46 项断言。
`graph.test.js` 覆盖：完整可达性判定、无启用电源 / 全挂牌可申请、
“前 200 条支路均在挂牌处截断、其后直达设备”的核心回归、超长路径
（>64 节点）见证路径、含环图、243 条路径数量触顶、违规许可的截断信息，
共 31 项断言。
`advisor.test.js` 覆盖：汇合点单开关最小割（演示网络 K3）、已隔离 / 无启用
电源空步骤、无开关通路与无开关旁路不可行见证、并联支路多点割、已挂牌零成本、
已分闸只挂牌、含环图、停用电源、>64 节点超长链不依赖枚举上限、201 支路
402 步超限不截断、结果确定性与自定义上限，共 42 项断言；`advice.e2e.js`
另覆盖建议只读（不改修订号 / 审计）、带入预演确认、确认必须使用建议
revision 与 409 STALE_REVISION，共 50 项断言。
`tagrisk.test.js` 覆盖：逐挂牌开关假设失效的风险判定、串联挂牌互相挡住时
无单点风险、未挂牌开关不出现、停用电源方向不产生风险、开关 / 许可稳定排序、
空报告、>64 节点超长链仍给出真实见证路径（不依赖诊断展示上限）、输入不被
修改，共 31 项断言；`tagrisk.e2e.js` 另覆盖筛选参数校验（空组 / 重复 /
非正整数 / 非有效编号）、真实带电路径、报告只读（修订号 / 审计 / 开关 /
许可均不变）、多许可排序与筛选、全部许可结束后空报告，共 51 项断言。
