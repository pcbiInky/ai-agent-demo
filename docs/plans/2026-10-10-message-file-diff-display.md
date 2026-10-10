# 消息内文件修改 Diff 展示方案（v15，修正混合截断场景的矛盾文案）

日期：2026-10-10
作者：马哥（qodercn）
状态：v15 已实施，待 YYF 复审
变更记录：
- v1 纯前端聚合方案；
- v2 增加执行结果回报链路（YYF 认可方向，提出 5 点修订）；
- v3 按复核意见修订存量语义、净 Diff 链校验、降级统计、结果关联、回报失败语义；
- v4 修复代码评审发现的 3 个缺陷（413 静默漏记、deny 后可写成功记录、大文件无变化仍计数）；
- v5 修复第二轮评审的 2 个缺陷（并发乱序净 Diff 不一致、hash 失败误判无变化）并同步 oversized 阈值文案；
- v6 修复第三轮检视的 2 个内容准确性问题（空文件/末尾换行行数错误、内容读取失败伪装成有效快照）；
- v7 修复第四轮检视的 1 个同类边界（执行后文件已不存在被画成"空文件"）；
- v8 修复第五轮检视的 1 个紧邻边界（before/after 均缺失被判成"无变化"而整条丢弃）；
- v9 修复铲屎官提出、YYF 复核确认的 2 个时序问题（P1 刷新期间结果漏显、P2 用回报到达序当写入序）；
- v10 修复 P2 遗留边界（同文件混有无快照操作时，片段被误称为文件「净 Diff」）；
- v11 修复目录摘要与 v10 语义不一致（无快照记录位置不可证时仍标「分段」），并在 §0.8 标明 v5 的"按 seq 当执行完成序"旧方案已被 v9 取代；
- v12 修复 YYF 第六轮检视的 2 个问题（P1 服务无访问边界、完整文件快照对同网段公开；P2 "窄而长"内容绕过 LCS 单元格上限导致单面板同步创建约 8 万行节点）；
- v13 按 YYF 第七轮复审补齐 2 点（面板级渲染**总**预算，覆盖多段场景；P1 结论表述收敛为"默认模式已缓解、跨设备模式风险待铲屎官决定"）；
- v14 修复 YYF 第八轮复审指出的截断提示归因错误（单块 1500 行上限被说成"面板总预算已用尽"，并承诺明细可看到实际同样被截断的尾部）；
- v15 修复 YYF 第九轮复审指出的混合场景矛盾文案（单块截断汇总里断言"面板总预算未用尽"，与同屏的面板总上限提示冲突）。

## v15 修复内容（YYF 第九轮复审：混合截断场景文案）

**问题**：同一面板先有一块 2000 行（按单块上限渲染 1500）、再有四块各 1500 行时，`truncatedBy` 依次为 `block, null, null, null, panel`，面板预算最终为 0。此时面板同时出现「片段区已达到面板渲染总行数上限 6000」与单块汇总里的「（面板总预算未用尽）」，两句互相矛盾。

**修复**：单块汇总改为不依赖最终预算状态的中性表述——「X/Y 个片段由单块渲染上限 1500 行截断，被截去的尾部在逐次操作明细中同样不会显示」（`public/app.js:1716`）。判定逻辑与两条提示的触发条件不变（`panelTruncated` / `blockTruncated` 各自独立计数）。

**回归用例（混合原因）**：同文件 5 段互不连续快照链，首段 diff 2000 行、后四段各 1500 行 → 面板 `.diff-line` = 6000；首块提示「仅渲染前 1500 行（共 2000 行）：单个 diff 块最多渲染 1500 行…」；末块提示「未渲染该块（共 1500 行）：已达到面板渲染总行数上限 6000」；汇总同时含「片段区已达到面板渲染总行数上限 6000：1/5 个片段未完整显示」与「1/5 个片段由单块渲染上限 1500 行截断」，且全文不含「面板总预算未用尽」。


## v14 修复内容（YYF 第八轮复审：截断原因归因）

**问题**：v13 的 `openDiffPanel` 只要某块未完整显示就计入 `omittedSegments`，随后统一声称"已达到面板渲染总行数上限 6000，可在下方明细按需展开"。但单块 2000 行是被 **1500 行单块上限**截断（此时面板预算还剩 4500，实测 `rendered=1500, budgetRemaining=4500`），而明细展开同样受 1500 行单块上限约束——文案既错误归因，又承诺了明细做不到的事。

**修复**：
- `buildDiffCodeBlock` 区分两种原因并记录在 `body.truncatedBy`（`"panel"` / `"block"`）：以 `blockOnly = min(lines.length, MAX_DIFF_RENDER_LINES)` 为参照，`shown < blockOnly` 才是面板预算耗尽，`shown === blockOnly < lines.length` 是单块上限。
- 块内提示分文案：面板预算耗尽 →「未渲染该块（共 N 行）：已达到面板渲染总行数上限 6000」或「仅渲染前 N 行（共 M 行）：面板渲染总行数上限 6000 已用尽」；单块上限 →「仅渲染前 1500 行（共 M 行）：单个 diff 块最多渲染 1500 行，其余未显示以避免界面卡顿」。
- 面板汇总拆成两条独立提示：`panelTruncated > 0` 才出现"片段区已达到面板渲染总行数上限 6000：X/Y 个片段未完整显示，逐次操作明细另有独立预算，可按需展开"；`blockTruncated > 0` 则出现"X/Y 个片段受单块渲染上限 1500 行约束被截断（面板总预算未用尽），被截去的尾部在逐次操作明细中同样不会显示"。
- 回归用例：单元级——`buildDiffCodeBlock(computeLineDiff("", 2000 行), { left: 6000 })` → `renderedLines=1500`、`budget.left=4500`、`truncatedBy="block"`、提示含"单个 diff 块最多渲染 1500 行"且不含"面板渲染总行数上限"；面板级——单段 2000 行文件打开面板只渲染 1500 行，汇总归因为单块上限、全文不含"面板渲染总行数上限"、含"被截去的尾部在逐次操作明细中同样不会显示"。


## v13 修复内容（YYF 第七轮复审：面板级总预算、P1 表述）

### v13-P2b 面板级渲染总预算（多段场景）

**问题（YYF 复现）**：v12 的 `MAX_DIFF_RENDER_LINES=1500` 只是**每个 diff 块**的上限，`openDiffPanel` 会同步遍历渲染全部 `summary.segments`，懒渲染只作用于逐次明细。构造同文件 60 个互不连续的有效快照链（每段约 1500 行、单次 before+after 远低于 80KB）时 `orderUnknown=false`、60 段，打开面板初始仍创建约 **90000 个 `.diff-line` 节点**，与"每个面板的输出节点/行数预算"的要求有差距。

**修复**：
- 新增面板级总预算 `MAX_PANEL_RENDER_LINES = 6000`，以 `{ left }` 计数对象贯穿同一面板的所有 `buildDiffCodeBlock(diff, budget)` 调用；单块实际上限 = `min(MAX_DIFF_RENDER_LINES, budget.left)`，因此同屏节点数由**总预算**而非块数决定。
- 片段区与明细区各持一份预算：片段区打开面板即同步消耗（≤6000 行），明细区首次展开才消耗（≤6000 行，且按用户动作增量发生），故同屏上界为两份之和，且不会因段数增加而放大。
- 预算耗尽的块显示「未渲染该块（共 N 行）：已达到面板渲染总行数上限 6000」；片段区结束后追加汇总提示「片段区已达到面板渲染总行数上限 6000：X/Y 个片段未完整显示，可在下方逐次操作明细中按需展开」，给出**省略数量**。
- 标签、统计与拆段语义不变（60 段仍全部列出标签、`diffStatLines` 仍基于完整内容），只有行节点的渲染被限流。
- 回归用例：同文件 60 段互不连续快照链（每段 100 行全量替换 → 每段 200 条 diff 行，合计 12000 行）→ 面板初始 `.diff-line` = 6000、60 个片段标签全在、提示含「30/60 个片段未完整显示」与「未渲染该块」、明细折叠时 0 行、展开一条后总节点 6200（≤ 双预算之和）。

### v13-P1 P1 结论表述修正

v12 汇报中"访问边界已修复"的说法过宽，按 YYF 要求修正为：**默认模式（不设 `HOST`）已缓解**——服务只监听 `127.0.0.1`，同网段设备无法访问；**跨设备模式风险仍存在且待铲屎官决定**——显式设置非回环 `HOST` 时 `/api/sessions`、`/api/history`、`/api/events` 依旧无鉴权，启动告警只是提示、不阻止读取日志中的完整文件快照。若铲屎官确需跨设备访问，必须对这三个接口一并建立访问控制（只封其中一个无意义），该项未实施。


## v12 修复内容（YYF 第六轮检视：P1 访问边界、P2 渲染预算）

### v12-P1 服务默认只监听回环地址

**问题**：`server.js` 用 `app.listen(PORT, cb)` 启动，未指定 host，实际监听所有网卡，而启动日志只打印 `localhost`，造成"仅本机"的错觉。`GET /api/sessions`（无鉴权，返回 sessionId）、`GET /api/history`（仅需 sessionId）、`GET /api/events`（无鉴权 SSE）三个接口都没有访问控制；本方案又把完整 `before/after` 文件快照写入 `execution` 并落到 `chat-logs`，等于把"同网段任意设备可读取被改文件的完整前后内容"变成默认行为。

**修复**：
- 新增 `const HOST = process.env.HOST ?? "127.0.0.1"`，`app.listen(PORT, HOST, cb)`；启动日志打印真实绑定地址（`http://127.0.0.1:PORT`）。
- 绑定地址非回环（`127.0.0.1` / `::1` / `localhost`）时输出安全告警，明确列出无鉴权接口与"日志含完整文件快照"这一数据范围，提示仅本机使用请取消 `HOST`。
- 回归断言 `server.serverInstance.address().address === "127.0.0.1"`（`serverInstance` 已导出）。
- **未实施**：跨设备访问的 token 鉴权。若要保留跨设备访问，需对 `/api/history`、`/api/sessions`、`/api/events` 一并鉴权（只封一个接口无意义），这会改变铲屎官现有的使用方式，已作为待决策项提交，不擅自实施。

### v12-P2 diff 渲染预算与明细懒渲染

**问题**：80KB 快照预算允许 `after = "\n".repeat(40000)`（40000 字节）。`computeLineDiff("", after)` 的 LCS 矩阵只有 `1×40001`，不触发 250000 单元格降级，得到 `degraded=false` 与 40000 条 diff 行；`openDiffPanel` 会为净 Diff 与逐次明细各调用一次 `buildDiffCodeBlock`，同步创建约 8 万个行节点（实测单块 40000 节点耗时 230ms，主线程阻塞）。

**修复**：
- 新增 `MAX_DIFF_RENDER_LINES = 1500`：`buildDiffCodeBlock` 最多渲染前 1500 行，超限时追加 `.diff-note`「仅渲染前 N 行（共 M 行），其余未显示以避免界面卡顿」。行级 diff 的计算与统计不受影响（`diffStatLines` 仍基于完整 lines）。
- 逐次操作明细改为**懒渲染**：`<details>` 首次 `toggle` 展开时才 `computeLineDiff` + `buildDiffCodeBlock`，避免同一面板把大 diff 渲染两遍。
- 回归用例：纯换行内容不降级但 40000 行；单块节点被截断至 1500 且有提示；打开面板后折叠明细无 `.diff-line`，面板初始行节点 ≤ 1500，展开后仍受预算约束。


## 0. v9/v10/v11 修复内容（P1/P2 时序问题）

### 0.1 [P1] 刷新期间的执行结果永久漏显

**问题**：`loadHistory` 清空 `state.permRequestIndex` 后只为"已带 execution"的历史记录做聚合，没有为"审批已入历史快照、execution 尚未回报"的记录重建索引；`permission-executed` 监听器第一行 `if (!req) return;` 直接丢弃未知 requestId。而 `/api/history` 的 `lastSeq` 已覆盖历史中的 permission 事件，SSE 重连不会重放，因此结果在快照之后到达时**永久漏显**（服务端仍会写回日志，只有再刷一次才看得到）。

**修复**：`loadHistory` 遍历 permission 记录时，对 `!msg.execution && msg.requestId && msg.status !== "deny"` 的记录回填 `permRequestIndex[msg.requestId] = { ...msg, approved: msg.status === "allow" }`（保留 status/approved 语义：allow 视为已批准，pending 等后续 `permission-resolved` 置位）。晚到的 `permission-executed` 即可命中索引，走 `recordFileChange` + `refreshFileDiffDirectory`（`replyByThinking` 在历史遍历时已重建，回复已渲染也能补挂）。索引条目在结果到达后即删除，不累积。

### 0.2 [P2] seq 是"回报到达序"，不能当"文件写入序"

**问题**：`server.js` 在收到 `/api/tool-result` 时才 `nextExecutionSeq()`，而工具在此之前已完成写入与快照，POST 是异步的；前端只按 seq 排序，等于把网络到达序当执行序。同一文件真实序 x→y→z，若第二次修改的回报先到，前端会倒置为 A(y→z)、B(x→y)，链校验断开 → 误拆 2 段、误标"范围外修改"、合计从 +1/-1 变成 +2/-2。

**修复**：不再用 seq 推断顺序，改为**按快照连续性重建可确定的链**（`orderFileChanges`）：
- 有快照的记录中，若某个 `before` 或 `after` 状态重复出现（分支），或链首搜索后仍有记录未入链（成环，如改回原内容的 undo），则**顺序不可判定**：整文件标 `orderUnknown`，目录显示「顺序未知」（不给 +/- 合计），面板明示"同文件多次修改的先后顺序无法确定（快照状态重复或成环），未计算净 Diff 与合计"，但**保留逐次操作明细**（单条 before/after 本身可信）。
- 状态唯一时链可确定：以"没有前驱（无其他记录的 after 等于它的 before）"为链首，沿 `byBefore.get(after)` 唯一延伸；多条互不连续的链 = 存在范围外修改，仍按原语义拆段并标注，链间先后仅影响展示顺序，用 `(finishedAt, seq)` 做提示性排序。
- 无快照记录（oversized / snapshotError）仍按 `(finishedAt, seq)` 落在基线位置，作为断点计入 uncovered。
- `recordFileChange` 的排序键从"仅 seq"改为 `(finishedAt, seq)` 基线序，只用于保证实时与历史拿到同一份稳定输入；**顺序正确性由快照链保证，不依赖时钟**（跨主机/时钟回拨也不影响判定）。

### 0.3 回归用例（v9 新增）

- P1：审批入历史快照（allow，无 execution）+ 回复已渲染 → 刷新后 `permission-executed` 到达，目录补挂 1 条；历史中为 pending 的记录，刷新后 resolved + executed 同样计入（2 条）。
- P2 实时：真实写入序 B(x→y, finishedAt 402) → A(y→z, finishedAt 403)，但 A 的回报先到（seq 1001 < 1002）→ 单段净 Diff、+1/-1、无"分段"与"范围外修改"。
- P2 历史：同样倒序落盘（pA seq 501/finishedAt 8，pB seq 502/finishedAt 7）→ 与实时一致的单段 +1/-1。
- 顺序未知：同一文件两次 before/after 完全相同的修改 → 目录「顺序未知」、面板无净 Diff、保留 2 条逐次明细。

### 0.4 [P2 补充，v10] 混入无快照操作时不得称「净 Diff」

**问题**：`orderFileChanges` 用 `(finishedAt, seq)` 固定无快照记录（oversized / snapshotError）的位置，而这两个键仍是完成时间/回报序，**不能证明它相对快照链的写入顺序**。最小例子：真实写入 A(x→y)、B(y→z)、C(z→大文件，oversized 无快照)，三者 `finishedAt` 同毫秒、C 的回报先到（seq C=1、A=2、B=3）→ 推断顺序 C,A,B，`orderUnknown=false`，得到唯一快照片段 x→z 且 `uncovered=1`；面板把它标为「净 Diff」，但文件最终内容是 C 写入的大文件。目录虽已显示「增删未知」，面板标签仍会误导；链间「范围外修改」也可能把**已记录的无快照操作**误称为范围外。

**修复**：只有「单段 + 全部操作都有快照」才称「净 Diff」；`uncovered > 0` 时片段一律降级为 **「局部快照片段 · 段 i/n（该文件另有 N 次修改无可用快照，相对位置不可证，不代表文件最终净变化）」**，且此时不再使用「范围外修改」措辞（无法归因）。uncovered 说明补一句「这些记录相对快照链的先后无法证明，下方明细顺序仅为提示」。全部记录都有快照、但链不连续时（真正的范围外修改），仍保留「净 Diff · 段 i/n（段间存在范围外修改…）」的分段语义；链间排序只作展示顺序。

**回归用例（v10 新增）**：同毫秒 + 回报倒序 + 混入 oversized 的 mix.js（3 次修改）→ 目录「增删未知」且不标「分段」；面板无「净 Diff」标签、出现「局部快照片段」「不代表文件最终净变化」「先后无法证明」、不含「范围外修改」、逐次明细保留 3 条。

**补充修复（v11）：目录「分段」标签同样受 uncovered 约束**。v10 只改了面板文案，目录的 `segLabel` 仍只看 `summary.segments.length > 1`。最小例子：同文件 A(x→y)、C(oversized 无快照)、B(y→z)，三次 `finishedAt` 同毫秒、seq 依次 1/2/3 → `orderFileChanges` 得 A,C,B，`buildFileDiffSegments` 得 2 段、uncovered=1，目录显示「增删未知 · 3 次 · 分段」。但 C 的位置不可证，"分成两段"本身仍是基线排序的推断，与 v10「uncovered>0 不下结论」的语义矛盾。现改为 **仅 `uncovered === 0 && segments.length > 1` 才标「分段」**；面板仍按 2 个「局部快照片段」展示并保留先后不可证说明。回归用例：mix2.js（A/C/B 同毫秒、seq 3001/3002/3003）→ 目录含「增删未知」且不含「分段」，面板 2 个局部快照片段、每段均明示「不代表文件最终净变化」、全文不含「净 Diff」。

## 0.5 v8 修复内容（对应 YYF 第五轮检视）

1. **[中] before/after 均缺失被判成"无变化"**：v7 的 `afterMissing` 定义为「after missing **且** before 非 missing」，于是"Write 新建文件后立刻被外部删除"这类两侧都缺失的场景，`classifySnapshot` 返回 `{ changed: false, snapshotError: true }`（两侧 hash 同为 null 视为相等），前端按 `changed === false` 丢弃整条记录，与 v7 声明的"after 缺失一律变更状态未知"不符。现把条件收窄为 **`afterSnap.status === "missing"` 即视为内容不可得**：成功的 Edit/Write/NotebookEdit 都应留下文件，after 缺失一律 `snapshotError` 且 `changed` 未知（保留为"变更状态未知"的成功操作，不生成虚假 Diff，也不会被前端丢弃）。
2. **回归用例**：`test-tool-result-reporter.js` 补 before/after 均 missing 的分类断言（snapshotError、changed 未知、不带 before/after），classifySnapshot 矩阵共 11 项。

## 0.6 v7 修复内容（对应 YYF 第四轮检视）

1. **[中] 执行后文件已不存在仍生成有效 Diff**：原 `withFileSnapshot` 在 `afterSnap.status === "missing"` 时强行令 `afterContent = ""`，把外部删除/竞争导致的"文件缺失"回报成 `diffAvailable: true` 的空文件 Diff。既然成功的 Edit/Write/NotebookEdit 都应留下文件，**after 缺失一律走 `snapshotError`**（不带 before/after，且 `changed` 未知，不判 true/false）。
2. **可测试化重构**：快照形态判定抽为 `lib/tool-result-reporter.js` 的纯函数 `classifySnapshot({ beforeSnap, afterSnap, beforeContent, afterContent, totalSize })`，统一返回 `{ changed?, snapshotError }` / `{ changed?, oversized }` / `{ changed?, before, after }`；优先级为 **内容不可得（hash error / after 缺失 / 读取失败）> 超预算 oversized > 有效快照**。permission-server 只负责采集输入并回报，判定逻辑可被单测确定性覆盖（after 缺失是竞争场景，端到端无法稳定复现）。
3. **文案同步**：面板明细 snapshotError 文案改为「快照不可用：文件不可读或执行后已不存在，变更状态未知」，目录级 uncovered 提示同步补充"执行后已不存在"。

## 0.7 v6 修复内容（对应 YYF 第三轮检视）

1. **[中] 空文件与末尾换行的行数错误**：`computeLineDiff` 不再直接 `split("\n")`（会把末尾空 token 当成一整行，导致 `null→""` 与 `"a"→"a\n"` 都虚报 +1）。新增 `splitDiffLines`：末尾换行不算独立行，空文件与缺失文件均为零行，并返回 eol 状态（true=以换行结尾 / false=末尾无换行 / null=文件不存在）。两侧 eol 状态变化时在 Diff 末尾追加 `meta` 行（`\ 修改前文件末尾无换行` / `\ 修改后文件末尾无换行`），**不计入 +/- 统计**（`diffStatLines` 只数 add/del），前端以 `.diff-line.meta`（琥珀色斜体）渲染且不加 +/- 前缀。
2. **[中] 内容读取失败伪装成有效快照**：`withFileSnapshot` 的成功分支不再用 `afterContent ?? ""` 兜底——`after` 读取失败，或文件原本存在（`beforeSnap.status !== "missing"`）但 `before` 读取失败，一律回报 `snapshotError: true`（不带 before/after，changed 仍按 hash 判定）；只有"文件原本不存在"才允许 `before: null`（新文件语义）。`server.js` 的 `snapshotValid` 相应收紧为 `before === null || string`，且 **`after` 必须是字符串**，`after: null` 的成功回报返回 400（不消费关联、不写 execution）。

## 0.8 v5 修复内容（对应 YYF 第二轮代码评审）

1. **[高] 并发编辑乱序导致实时与历史净 Diff 不一致**：server.js 在 `/api/tool-result` 写入 execution 时生成**服务端单调 `seq`**（计数器初值取时钟，重启后仍单调）；前端 `recordFileChange` 每次归档后按 `execution.seq` 排序，实时（事件到达序）与历史（日志请求序）统一为执行完成序，再做快照连续性校验。回归用例：A 先申请后执行（seq 大）、B 后申请先执行（seq 小），实时与历史均合并为单段净 Diff（x→z），不再误标"范围外修改"。
   > **本条的排序方案已被 v9 取代（历史记录，勿按此实现）**：`seq` 是服务端**收到回报**的到达序，不是执行完成序，把它当完成序会在回报倒序时颠倒同文件修改顺序（见 §0.2 P2）。现行设计中顺序由**快照连续性重建**（`orderFileChanges`）决定，`(finishedAt, seq)` 只作链间展示顺序与无快照记录位置的提示，且不可证时一律降级标注（§0.4）。
2. **[中] hash 失败被当成"无变化"、成功 Write 漏记**：`hashFile` 返回 `{ status: ok|missing|error, hash }`，**区分"文件不存在"与"读取失败"**；任一快照 hash 为 error 时 `changed` 不写入（未知，绝不判 false），并按**无快照结果**回报 `snapshotError: true`（不带 before/after，服务端跳过快照字段校验，不会 400）。仅可写不可读文件的成功 Write 现在会记录为"变更状态未知、增删未知"，不再静默丢失。
3. **文案同步**：方案与前端所有 oversized 表述统一为"before+after 合计 80KB 快照预算"；面板明细区分「超过快照预算」与「文件不可读，变更状态未知」两种无快照原因。

## 0.9 v4 修复内容（对应 YYF 第一轮代码评审）

1. **[高] 413 静默漏记**：快照上限从"单文件 100KB"改为 **before+after 合计 80KB**（`SNAPSHOT_TOTAL_MAX_BYTES`，低于 express.json 默认 100KB 请求体上限），且**执行后复查文件大小**（after 超限同样触发 oversized）。回报逻辑抽到 `lib/tool-result-reporter.js`：检查 HTTP 状态码，含快照的回报被拒（如 413）时**自动降级为仅 oversized 重试一次**，仍失败才记"可观测性缺口"告警。
2. **[高] 被拒请求可写成功记录**：`registerToolResultCorrelation` 从权限请求时**移到审批通过时**（自动通过分支 + permission-response allow 分支），deny/超时根本不建立关联，回报一律 404。`/api/tool-result` 强化校验：toolName 必填且必须匹配、`ok` 必须为布尔、`filePath` 必填、成功且非 oversized 时 before(string|null)/after(string) 类型强校验；校验失败不消费关联、不写日志。
3. **[中] 大文件无变化仍计数**：`withFileSnapshot` 执行前后做**流式 sha256**（大文件不占内存），回报 `changed` 字段写入 execution；前端 `recordFileChange` 对 `changed === false` 一律不计入（覆盖 oversized Write 相同内容等场景）。
4. **测试补齐**：`test-tool-result-reporter.js`（hashFile、413 降级重试、无快照不重试、网络失败，18 项）；`test-tool-result.js` 增加 deny 后回报 404、toolName 缺失/ok 非布尔/缺快照 400、changed 写入等（29 项）；`test-file-diff-display.js` 增加 oversized changed=false 不计入、changed=true 计入且统计未知（26 项）。

## 1. 背景与目标

AI 角色执行过程中通过 MCP permission-server 的 Edit/Write/NotebookEdit 工具修改文件。目标：

1. 在角色的最终回复消息末尾（`.msg-model` 之后），展示本轮**已记录的成功文件修改**目录（路径 + 净增删行统计 + 修改次数）。
2. 点击目录中的文件，右侧滑出侧边面板，展示净 Diff（带链完整性校验）与逐次操作明细。

**范围声明**：仅覆盖 Edit / Write / NotebookEdit 三个工具且执行成功、结果已回报的记录。Bash 等其他途径的修改不在范围内；目录标题明确标注工具范围与"已记录"语义（见 §3.5 可观测性缺口）。

## 2. 数据链路（v2 已定，v3 补充关联机制）

- permission-server 对三个编辑工具"快照执行"：批准 → 读 before → 执行 → 读 after → POST `/api/tool-result`。
- server.js 校验关联后将 `execution` 字段写回 permission 日志条目，并广播 SSE `permission-executed`。
- 前端聚合 `status==="allow"` 且 `execution.status==="success"` 的记录，按 `character|messageId` 归组，回复渲染时挂目录。

## 3. v3 修订内容（对应 YYF 复核意见 1-5）

### 3.1 存量历史记录（意见 1）

**本期完全不展示无 `execution` 字段的旧审批记录**：不进入目录、不计次数、不计增删统计、面板不渲染。消除"成功执行"与"未验证审批片段"的语义混杂。存量数据的展示留待后续版本以独立的"未验证审批记录"视图实现。

### 3.2 净 Diff 链校验（意见 2）

同一文件本轮多次修改，聚合净 Diff 前逐对校验快照连续性：

- 校验规则：`changes[i].execution.before === changes[i-1].execution.after`（字符串全等；快照缺失/oversized 的 change 视为断点）。
- **校验前先按快照链重建顺序**（v9，见 §0.2）：顺序不可依赖 seq（回报到达序），由 `orderFileChanges` 依据 before/after 唯一连续性重排；重复状态或成环时整文件标 `orderUnknown`，不出净 Diff 与合计。
- 连续 → 合并为一段，净 Diff = 段首 before vs 段末 after。
- 不连续 → **拆段**，每段独立渲染净 Diff，段间标注「此处存在范围外修改（Bash/用户/其他会话），未计入本轮工具变更」。多段时目录统计标注为分段合计并带 `~` 前缀说明（仅合计各段内真实 diff 行数，不跨段）。
- 片段命名（v10）：仅「单段 + 全部操作都有快照」才称「净 Diff」；存在无快照记录时改称「局部快照片段」并明示不代表文件最终净变化、不归因范围外修改（见 §0.4）。
- `before === after` 的成功操作（无实际变化）：**不进入目录**，不计次数。

### 3.3 降级统计语义（意见 3）

统一原则：**没有可信行级 diff 就不给 +/- 数字**。

- 快照超过 before+after 合计 80KB 预算（oversized），或内容不可得（hash 失败 / 读取失败 / 执行后文件已不存在，snapshotError）：permission-server 不上报内容，也不上报 added/removed（行数差不能推出增删行）；前端显示「未计算行级 Diff」，统计显示「未知」。
- ≤80KB 但 LCS 单元格 >250000：前端降级，同样显示「未计算行级 Diff」+「未知」，不使用任何推算数字（v2 中"使用后端 stats"的表述作废——该分支后端本就不上报 stats）。
- 正常分支：LCS 行级 diff，+/- 为真实数字；行拆分遵循 `splitDiffLines` 语义（末尾换行不算独立行，空文件/缺失文件零行），eol 状态变化以 meta 行提示且不计入 +/-。

### 3.4 结果回报关联（意见 4）

不复用 30 秒 TTL 的 `approvedRequests`。server.js 新增独立关联表：

```js
toolResultCorrelations: Map<requestId, { browserSessionId, character, toolName, messageId, createdAt }>
```

- 在 `/api/permission-request` 收到三个编辑工具的请求时建立（无论自动通过还是待审批）。
- `/api/tool-result` 校验：requestId 存在、toolName 一致、**一次性消费**（收到即删除，重复回报 404）。
- TTL 2 小时兜底清理（定时器 unref），覆盖慢操作；进程重启导致关联丢失时回报返回 404，permission-server 仅记 stderr（见 §3.5 缺口声明）。

### 3.5 回报失败语义与补挂（意见 5）

- 目录标题文案定义为「**已记录的文件修改**（Edit/Write/NotebookEdit）」：POST /api/tool-result 失败（server 不可达/重启）时工具执行成功但界面漏记，属于**明示的可观测性缺口**，本期不做重试/本地缓冲。
- 时序异常补挂：前端维护 `replyByThinking`（`character|messageId` → replyId）。`permission-executed` 晚于 `reply` 到达时，若对应回复已渲染，则**刷新（upsert）**该回复的目录；目录渲染函数幂等，先移除旧 `.file-diff-dir` 再重建。

### 3.6 已确认项（v2 复核通过，不变）

- Edit 的 permission input 补传 `replace_all`。
- Write/NotebookEdit 采 before/after 快照，diff 为真实内容对比。
- 目录位于 `.msg-model` 之后（严格消息最后）。
- thread 深层回复（depth>0）与 mcp-tool source 的 reply 同样覆盖。
- 路径裁剪仅当 `filePath.startsWith(wd + "/")`，避免 `/repo` 误裁 `/repo2`。

## 4. 文件改动清单

| 文件 | 改动 |
| --- | --- |
| `permission-server.js` | Edit input 补 `replace_all`；三个编辑工具快照执行；POST /api/tool-result（before+after 合计 80KB 预算，被拒降级重试） |
| `server.js` | `toolResultCorrelations` 关联表；`POST /api/tool-result`（校验 + 一次性消费 + 写回 execution + SSE permission-executed） |
| `public/index.html` | `#diff-panel` 侧边面板节点（已完成） |
| `public/app.js` | state（fileChanges / permRequestIndex / replyByThinking）、聚合与链校验、`orderFileChanges` 快照链重建顺序（不可判定 → 顺序未知）、LCS diff（行语义 + meta 行 + 降级标注）、目录 upsert 渲染、侧边面板、SSE permission / permission-resolved / permission-executed / reply 钩子、loadHistory 钩子（含从历史审批重建 permRequestIndex） |
| `public/style.css` | 目录样式、侧滑面板、diff 行高亮（add 绿 / del 红 / ctx 灰）、拆段与降级标注样式 |

## 5. 已知限制

1. 存量历史（无 execution）本期不展示。
2. Bash 改文件不覆盖；净 Diff 拆段处只标注不追因。
3. 回报 POST 失败 = 漏记（明示缺口，无重试）。
4. oversized（合计 >80KB）/ snapshotError（hash 失败、内容读取失败、执行后文件已不存在）与 LCS 降级分支无行级 diff，统计「未知」。
5. 孤儿 permission 记录（messageId 为空）不聚合。
6. 快照反映工具执行时点，不回读当前磁盘内容。
7. 末尾换行状态变化只以 meta 行提示，不计入增删统计。
8. 同文件快照状态重复或成环（如改回原内容）时顺序不可判定：标「顺序未知」，不出净 Diff 与合计，只保留逐次明细。
9. 同文件混有无快照记录时，其相对写入位置不可证：片段只标「局部快照片段」，不称「净 Diff」，也不归因为「范围外修改」。
10. 单个 diff 块最多渲染 1500 行（`MAX_DIFF_RENDER_LINES`），且同一面板的片段区与明细区各受 6000 行总预算约束（`MAX_PANEL_RENDER_LINES`），超出部分只显示提示与省略数量，不显示内容；统计与行级 diff 计算仍基于完整内容。两种截断原因分别归因提示：单块上限截去的尾部在明细中同样看不到，只有面板预算耗尽时明细（独立预算）才可能补上。逐次明细展开时才渲染（懒渲染），因此折叠状态下 DOM 中无 diff 行。
11. 服务默认只监听 `127.0.0.1`（默认模式已缓解）；跨设备访问需显式设置 `HOST`，此时 `/api/sessions`、`/api/history`、`/api/events` 仍无鉴权，启动日志只告警不阻止读取日志中的完整文件快照——跨设备模式风险待铲屎官决定，三接口统一鉴权未实施。

## 6. 验收用例

1. Edit 成功：目录出现、净 Diff 与统计正确。
2. Edit 失败（old_string 不存在）：execution.status=error，不计入。
3. Edit replace_all：input 含 replace_all，快照 diff 与真实文件一致。
4. 同文件多次 Edit（连续快照）：合并一段净 Diff，明细逐条可展开。
5. 同文件两次 Edit 之间被 Bash/用户修改（快照不连续）：拆段 + 范围外修改标注。
6. before===after 的成功操作：不进入目录。
7. Write 覆盖已有文件 / 新建文件：diff 分别为真实对比 / 全新增。
8. NotebookEdit：JSON before/after diff 正确。
9. oversized（合计 >80KB）与 LCS 降级：显示「未计算行级 Diff」「未知」，无虚假 +/-。
10. /api/tool-result 重复回报、requestId 不存在、toolName 不匹配：分别 404/404/400，日志不被二次写入。
11. permission-executed 晚于 reply 到达：目录补挂/刷新正确。
12. 会话切换 / SSE resync：状态重建，无串会话、无重复。
13. thread 深层回复与 mcp-tool reply：目录正确挂载。
14. 路径前缀边界：wd=/repo 时 /repo2/a.js 不裁剪。
15. 实时与历史重载一致性：同一轮执行，SSE 实时目录与刷新后一致。
16. 空文件与末尾换行：`null→""` 与 `""→""` 均 0 行无虚假 +1；`"a"→"a\n"`、`"a\n"→"a"` 只出 meta 行且 +/- 为 0；`"a\n"→"a\nb\n"` 正常 +1。
17. 内容读取失败（hash 可得但 read 失败）：回报 snapshotError 而非空快照；`/api/tool-result` 收到 `after: null` 的成功回报返回 400。
18. 执行后文件已不存在（外部删除/竞争，含 before/after 均缺失）：回报 snapshotError 且 changed 未知，既不生成"空文件"有效 Diff，也不被判成"无变化"而丢弃；超预算同时 after 缺失时 snapshotError 优先于 oversized。
19. 刷新期间结果晚到（P1）：审批已入历史快照（allow 或 pending）、回复已渲染，执行结果在重连后到达 → 目录补挂，不永久漏显。
20. 回报到达序与写入序相反（P2）：同文件 x→y→z，第二次修改的回报先到 → 仍为单段净 Diff、+1/-1，不误拆段、不误标"范围外修改"；实时与历史一致。
21. 顺序不可判定：同文件出现重复快照状态或成环 → 目录显示「顺序未知」、面板明示不可判定、不出净 Diff 与合计，但保留逐次操作明细。
22. 混入无快照操作（同毫秒 + 回报倒序）：面板不得出现「净 Diff」，改标「局部快照片段」并明示不代表文件最终净变化、无快照记录先后无法证明；不误称「范围外修改」；逐次明细完整保留。
23. 无快照记录恰好把快照链切成两段：目录不得标「分段」（仅 `uncovered === 0 && segments.length > 1` 才标），面板仍按多个「局部快照片段」展示。
24. 纯换行大文件（`""→"\n"×40000`）：`computeLineDiff` 不降级但产生 40000 行；单个 diff 块只渲染前 1500 行并提示「仅渲染前 1500 行（共 40000 行）」；面板初始 `.diff-line` 节点数有界。
25. 逐次明细懒渲染：折叠状态的 `.diff-change-block` 内无 `.diff-line`，展开（toggle）后才渲染且同样受 1500 行预算约束。
26. 默认监听回环：`server.serverInstance.address().address === "127.0.0.1"`，启动日志打印真实绑定地址；显式设置非回环 `HOST` 时输出无鉴权接口与文件快照暴露的安全告警（告警不等于访问控制，跨设备模式风险仍在）。
27. 多段面板总预算：同文件 60 段互不连续快照链（合计 12000 条 diff 行）→ 面板初始 `.diff-line` 恰为 6000、60 个片段标签全部保留、提示含「片段区已达到面板渲染总行数上限 6000」与「30/60 个片段未完整显示」、被跳过的块含「未渲染该块」；明细折叠时 0 行，展开一条后总节点 6200（≤ 片段区 + 明细区两份预算）。
28. 截断原因归因：单块 2000 行且面板总预算未耗尽 → `renderedLines=1500`、`budget.left=4500`、`truncatedBy="block"`，提示为「单个 diff 块最多渲染 1500 行」且不出现「面板渲染总行数上限」；面板汇总归因为单块上限并明示「被截去的尾部在逐次操作明细中同样不会显示」。
29. 混合截断原因：5 段（首段 2000 行、后四段各 1500 行）→ `truncatedBy` 依次 `block, null, null, null, panel`，面板 6000 行；两条汇总并存且不矛盾（单块汇总为中性表述，不出现「面板总预算未用尽」）。

## 7. 实施进度

- [x] `public/index.html`：`#diff-panel` 面板节点。
- [x] `public/app.js`：`$diffPanel` 等 DOM 引用。
- [x] `permission-server.js`：Edit input 补 `replace_all`；三个编辑工具快照执行（合计 80KB 预算 + 执行后复查大小 + sha256 changed 判定，形态判定委托 `classifySnapshot`）+ 回报。
- [x] `lib/tool-result-reporter.js`：回报模块（状态码检查、413 降级 oversized 重试、流式 hashFile 区分 missing/error、`classifySnapshot` 纯函数：hash 失败/执行后文件缺失（无论执行前是否存在）/读取失败 → snapshotError 且 changed 未知，超预算 → oversized，否则有效快照）。
- [x] `server.js`：`toolResultCorrelations`（仅审批通过时注册，2h TTL、一次性消费）；`POST /api/tool-result`（toolName/ok/filePath/快照字段强校验，`after` 必须为字符串，snapshotError/oversized 免快照）；`execution`（含 changed、服务端单调 seq）写回日志；SSE `permission-executed`；v12 默认绑定 `HOST ?? "127.0.0.1"`、启动日志打印真实地址、非回环时输出访问边界告警。
- [x] `public/app.js`：聚合（仅 allow+success 且 changed≠false，基线序 finishedAt→seq）、`orderFileChanges`（按快照连续性重建顺序，重复状态/成环 → orderUnknown）、LCS diff（`splitDiffLines` 行语义 + 末尾换行 meta 行 + 降级标注）、净 Diff 链校验拆段、目录 upsert 渲染（.msg-model 之后，含「顺序未知」态；「分段」仅在 uncovered===0 且多段时标注）、侧栏面板（区分 oversized/snapshotError/顺序未知 文案，无快照记录参与时片段降级为「局部快照片段」，逐次明细懒渲染，单块渲染上限 `MAX_DIFF_RENDER_LINES=1500`、面板级总预算 `MAX_PANEL_RENDER_LINES=6000`（片段区与明细区各一份），截断原因经 `truncatedBy` 区分并分别提示单块上限／面板预算耗尽）、SSE 钩子、loadHistory 钩子（含从历史审批重建 permRequestIndex）、补挂机制。
- [x] `public/style.css`：目录、侧滑面板、diff 高亮（含 `.diff-line.meta`）、拆段/降级标注样式。
- [x] 测试：`test-file-diff-display.js` 90 项（含回报倒序的实时/历史一致性、刷新后晚到结果补挂（allow 与 pending 两种）、重复快照状态标「顺序未知」、混入无快照记录时面板降级为「局部快照片段」且目录不标「分段」、snapshotError 计入、空文件/末尾换行边界与 meta 渲染、纯换行 40000 行的单块渲染预算与截断提示、明细懒渲染、60 段多片段的面板级总预算与省略数量提示、单块 2000 行时截断原因归因为单块上限而非面板预算、混合原因（block+panel 同屏）文案不矛盾）、`test-tool-result.js` 38 项（含 seq 单调、snapshotError 200、`after: null` → 400、默认监听回环）、`test-tool-result-reporter.js` 30 项（含 missing/error 区分、classifySnapshot 形态分类与 after 缺失／两侧均缺失回归）全部通过；既有 test-tool-records-fold（26）/ test-thinking-restore（56）/ test-metric-bar-label（9）/ test-permission-history（20）/ test-permission-context（51）无回归。另做 spawn permission-server 走 MCP stdio 的实机端到端复验（Write 新文件 before=null、Edit 快照真实、清空文件 after="" 不误报、失败 Edit 记 error+changed=false、seq 单调）。
