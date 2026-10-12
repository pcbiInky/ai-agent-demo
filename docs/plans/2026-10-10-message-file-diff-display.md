# 消息内文件修改 Diff 展示方案（v23，↑/↓ 与文件路径同一行）

日期：2026-10-10
作者：马哥（qodercn）
状态：v23 已实施（v20 的滚动手感铲屎官已认可；v23 的行内对齐观感待浏览器确认）
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
- v16 按铲屎官要求暂时移除 80KB 快照预算，观察大文件 Diff 的实际响应；仅 `/api/tool-result` 的传输请求体上限改为 100MB，LCS 计算上限从 25 万放宽到 1000 万单元格，单块渲染上限从 1500 行提高到 5000 行，面板每区 6000 行总预算保留。
- v17 按铲屎官要求删除面板中的「逐次操作明细」区，并放大净 Diff 窗口（面板宽 560→920px、代码区高度 420px→`calc(100vh - 200px)`）；因同屏只剩片段区一份预算，单块渲染上限 5000→12000 行、面板总预算 6000→20000 行；
- v17.1 修复 YYF 复审指出的 P2 占位问题（`min-height` 只作用于有 diff 行的块，预算耗尽的空块不再各占 240px）。
- v18 按铲屎官要求：打开面板自动把第一处增删行滚到代码区垂直中心，并为每行显示「修改前 / 修改后」行号（CSS 计数器实现，不增加 DOM 节点）；
- v18.1 修复 YYF 复审指出的 P2 定位缺口（外层滚动改为让**目标行**在面板视口居中，不再只看代码块顶部是否可见；仅末尾换行变化时把 meta 行也算作第一处修改）。
- v19 按铲屎官要求：代码区滚动条常显，并在滚动条旁加 VSCode 式概览标尺——按内容比例标出每处修改（可点击跳转）与当前视口位置。
- v20 按 YYF 的设计重做 v19 的导航（取代每块一条标尺）：`.diff-panel-content` 独占纵向滚动（代码块不再自己滚），面板右侧改为一条始终可见的窄刻度轨（每处修改一个刻度，点击跳转并居中），顶部加「上一处 i/N 下一处」吸顶工具条，滚动时同步当前序号，长行换行与面板尺寸变化后按比例重算刻度。
- v20.1 修复 YYF 复审 be5bb31 指出的生命周期缺口：打开面板的 rAF 回调加代次守卫并在关闭时取消，避免同一帧连续打开/关闭时旧回调重复构建或把已关闭的面板弹回来；
- v21 按铲屎官要求：「上一处/下一处」改成 ⬆️ / ⬇️ 符号按钮，并从面板内容里的吸顶工具条移到标题行、文件名右侧右对齐。
- v22 按铲屎官要求：按钮符号改 ↑/↓ 文本箭头（避免 emoji 跨平台渲染差异），控件从标题行内移到标题行下面独立的一行并右对齐。
- v23 按铲屎官要求：↑/↓ 不再独占一行，改为与文件路径行（`#diff-panel-sub`）同一行，路径吃掉剩余宽度把导航推到右边。
- v24 按铲屎官要求做视觉美化：纯 CSS，不改结构与行为。

## v24 变更：面板视觉美化（纯 CSS）

**需求（铲屎官）**：给 diff 窗口做一下美化。

- **面板与头部**：`.diff-panel` 阴影加深为 `-12px 0 40px rgba(20,18,40,0.18)`；标题 `h3` 改为等宽字体文件名胶囊（13.5px、`rgba(74,108,247,0.08)` 浅蓝底、6px 圆角），不加 `flex`（v23 断言仍要求标题行不带 flex）。
- **片段标签**：`.diff-seg-label` 从纯文字改为 `inline-block` 蓝色胶囊（浅蓝底 + 1px 蓝边 + 6px 圆角），`first-child` 与 `.diff-legend +` 的紧凑间距规则保留。
- **代码块**：`.diff-code` 边框从浅灰 `var(--border)` 改为深色 `#30363d`（与 `#0d1117` 底色衔接），加 `box-shadow` / `margin-bottom: 12px` / `padding: 6px 0`；`position: relative` / `overflow: hidden` / `counter-reset` 等行为性声明原样保留（测试按源码断言）。
- **diff 行**：add/del 背景调淡并加 2px 左侧色条（`inset 2px 0 0`，绿/红），文字改用 GitHub 深色主题色（`#7ee787` / `#ffa198`）；meta 行补 `rgba(210,153,34,0.08)` 浅琥珀底。当前处高亮规则 `.diff-line.diff-current { box-shadow: inset 3px 0 0 #4a6cf7; }` 原样保留——同 specificity 且位置更靠后，仍覆盖 add/del 的 2px 色条。
- **提示条**：`.diff-note` 改为带左侧色条的提示条；深色代码块内（截断/降级提示，`buildDiffCodeBlock` 追加在 `.diff-code` 内）用琥珀色亮字 + 半透明底（`.diff-code .diff-note` 两侧留 8px 空隙），面板浅色区域（汇总/顺序未知/图例）用深字浅底（`.diff-panel-content > .diff-note`）；`.diff-note.diff-legend` 图例用蓝色系与截断警告区分。
- **导航与刻度轨**：`.diff-nav-btn` 圆角 4→6px、加 transition 与 `:active` 下压；`.diff-nav-count` 改为蓝色小胶囊；`.diff-rail` 底色加深并加内描边。
- **不变**：DOM 结构、JS 行为、行号计数器、滚动/刻度/代次守卫逻辑全部未动；`test-file-diff-display.js` 180 项 + metric-bar-label(9) / tool-records-fold(26) / thinking-restore(56) 全部通过。
- **未验证项**：真实浏览器里的观感（胶囊、色条、阴影）需铲屎官确认。

## v23 变更：↑/↓ 与文件路径同一行

**需求（铲屎官）**：上下箭头可以和文件目录（面板里的文件路径行）调成一行吗。

- **结构**：`#diff-nav` 不再是标题行下面独立的一行，而是和 `#diff-panel-sub`（`openDiffPanel` 里写入完整文件路径）一起放进新的 `.diff-panel-subrow` 容器：`标题行 → .diff-panel-subrow（路径 + ↑ i/N ↓）→ .diff-panel-content`。头部因此回到两行，比 v22 少一行、内容区多约 32px。
- **布局**：`.diff-panel-subrow { display: flex; align-items: center; gap: 8px; flex-shrink: 0 }`，原来挂在 `.diff-panel-sub` 上的 `padding: 0 16px 10px` / `background: var(--chat-bg)` / `border-bottom` 全部上移到这一行容器，避免两个子元素各画一条底边框；`.diff-panel-sub { flex: 1 1 auto; min-width: 0 }` 吃掉剩余宽度把导航推到右边（`min-width: 0` + 原有 `word-break: break-all` 保证长路径仍能换行/不被挤爆），`.diff-nav { flex-shrink: 0 }` 且去掉自己的 `padding`/`background`/`justify-content`。
- **对齐细节**：路径行可能因长路径换成两行，`align-items: center` 让 ↑/↓ 相对整行垂直居中；控件 `hidden` 时该行只剩路径，视觉与 v20 之前一致。
- **未变**：按钮仍是 24×24 的 ↑/↓ 文本箭头（`title` 保留「上一处修改 / 下一处修改」），`hidden` 生命周期、`setupDiffPanel` 里一次性挂的 prev/next 监听、刻度轨与跳转居中逻辑、代次守卫全部不动。
- 回归用例：`.diff-panel-subrow { display: flex }` + `.diff-panel-sub { flex: 1 1 auto }` 样式断言；`.diff-nav` 不再自带 `padding`（行内边距统一由所在行给）且 `[hidden]{display:none}` 仍在；index.html 源码断言改为「`#diff-panel-sub` 与 `#diff-nav` 同处一个 `.diff-panel-subrow`」；按钮文本仍断言 ↑/↓；标题行不带 `flex`（控件不在标题行）。
- **未验证项**：真实浏览器里长路径换行两行时 ↑/↓ 的垂直居中观感、24px 按钮与 11.5px 路径文字的行高搭配、`gap: 8px` 是否够，仍需铲屎官确认。

## v22 变更：导航按钮改 ↑/↓ 文本箭头并独占标题下一行（行位置已被 v23 取代）

**需求（铲屎官）**：建议把 ⬆️/⬇️ 换成 ↑/↓，并把布局调整到下一行。

- **位置**：`#diff-nav` 从 `.diff-panel-header` 里移出，变成标题行下面独立的一行（顺序：标题行 → `#diff-nav` → `#diff-panel-sub` 路径行 → `.diff-panel-content`）。因为 `.diff-panel` 是 `flex-direction: column`，该行加 `flex-shrink: 0` 不被内容挤压；`padding: 0 16px 8px` 与 `background: var(--chat-bg)` 让它和上下两行连成同一片浅灰头部。
- **右对齐**：改用 `justify-content: flex-end`（不再需要 `margin-left: auto`），标题行也不再需要为控件让位，故 v21 给 `.diff-panel-header h3` 加的 `flex: 1 1 auto; min-width: 0` 一并回退。
- **符号**：按钮文本 ⬆️/⬇️ → ↑/↓（文本箭头），避免 emoji 在 macOS/Windows、Chrome/Safari 上的彩色渲染差异与基线偏移；`font-size` 12→14px、补 `color: var(--text)`，hover 同时变蓝字 + 蓝边 + 浅蓝底。按钮尺寸仍 24×24、`padding: 0`、`line-height: 1`，`title` 保留「上一处修改 / 下一处修改」以补足符号无语义的问题。
- **未变**：`hidden` 生命周期（`buildDiffNav` 显示 / `clearDiffNav` 隐藏）、prev/next 监听在 `setupDiffPanel` 挂一次、序号 `i/N` 夹在两个箭头之间、刻度轨与跳转/居中逻辑均不动。
- 回归用例：控件两个按钮文本为 ↑/↓；index.html 源码断言改为「关闭按钮所在标题行结束之后、`#diff-panel-sub` 之前」出现 `#diff-nav`（即独占下一行）；样式断言改为 `.diff-nav { justify-content: flex-end }` + `.diff-nav[hidden] { display: none }`，并断言 `.diff-panel-header h3` 不再带 `flex`（标题行无需为控件让位）。
- **未验证项**：↑/↓ 在真实浏览器里的字形大小与垂直居中、独立一行后头部总高度（约多 32px）是否挤压内容区，仍需铲屎官确认。

## v21 变更：符号导航按钮移入标题行右侧（位置已被 v22 取代，符号已改 ↑/↓）

**需求（铲屎官）**：这一版效果不错，把「上一处/下一处」两个按钮改成 ⬆️ / ⬇️ 这样的符号按钮，放到文件名右边、向右对齐。

- **结构**：控件不再是 `buildDiffNav` 动态插进 `.diff-panel-content` 的 sticky 工具条，而是 `public/index.html` 标题行里的常驻节点 `#diff-nav`（`.diff-nav`，默认 `hidden`），夹在 `#diff-panel-title` 与 `#diff-close-btn` 之间，内含 `#diff-nav-prev`（⬆️，title「上一处修改」）/ `#diff-nav-count`（i/N）/ `#diff-nav-next`（⬇️，title「下一处修改」）。
- **右对齐**：`.diff-panel-header h3 { flex: 1 1 auto; min-width: 0 }` 让文件名吃掉剩余宽度（`min-width: 0` 保证长路径仍能省略号截断），`.diff-nav { margin-left: auto; flex-shrink: 0; margin-right: 8px }` 紧贴关闭按钮左侧；按钮 24×24、`padding: 0`、`line-height: 1`，hover 蓝边 + 浅蓝底。
- **生命周期简化**：`buildDiffNav` 只做 `$diffNav.hidden = false`，`clearDiffNav` 只做 `hidden = true`（不再 remove/重建节点）；prev/next 的 click 监听在 `setupDiffPanel` 里挂一次（回调读 `_diffNav?.index`，与构建时机解耦）。控件移出滚动内容后，v20「先插入工具条再度量偏移」的顺序约束也随之消失。
- **代价/影响**：无修改处或全被预算截断时控件隐藏，标题行只剩文件名与关闭按钮；`.diff-nav` 不再需要 sticky（在标题行里天然常驻）；测试 DOM 是扁平 id 容器，`test-file-diff-display.js` 按 index.html 层级把三个子节点装进 `#diff-nav` 后再 eval，其余 4 个套件只补 IDS 让 `setupDiffPanel` 拿得到节点。
- 回归用例：有修改处时 `#diff-nav.hidden === false`、两个按钮文本为 ⬆️/⬇️、序号节点就是 `nav.counter`；resize 重建后全文档仍只有一份 `.diff-nav` 且序号按滚动位置恢复；`clearDiffNav()` 与关闭面板后 `hidden === true`；样式断言覆盖 `.diff-nav { margin-left: auto }`、`.diff-nav[hidden]`、`h3 { flex: 1 1 auto }`；index.html 源码断言覆盖控件位于 h3 与关闭按钮之间、按钮符号为 ⬆️/⬇️。
- **未验证项**：24px 符号按钮在真实浏览器里的点击手感、⬆️/⬇️ emoji 在各平台（macOS/Windows、Chrome/Safari）的渲染差异、与关闭按钮的间距观感，仍需铲屎官确认。

## v20.1 变更：打开/关闭回调的代次守卫（YYF 复审 P1）

- **YYF 指出的问题**：`openDiffPanel` 打开时清理旧标尺，却没有取消前一次 rAF；同一帧内连续打开文件时两个待执行回调都会对**当前**代码块调用 `buildDiffRulers`，第二次把已有 `.diff-code-wrap` 再包一层并登记第二组清理函数，随后 `clearDiffRulers()` 按登记顺序拆包，可能把 `.diff-code` 移入已脱离面板的旧 wrap，使面板内容消失（P1）。另有 P2：`buildDiffRuler` 在 `code.replaceWith(wrap)` **之前**读 `scrollHeight` 与行 `offsetTop`，而 wrap 的 `padding-right: 14px` 会缩窄代码区、让 `pre-wrap` 长行多换行，标记位置与视口比例从首次打开起就不准。
- **v20 已从结构上消除大部分前提**：不再有 wrap，也就没有「先包裹后测量」的时序问题（P2 消失；v20 的量测全部发生在面板 `open` 之后的 rAF 里）；`buildDiffNav` 幂等（开头 `clearDiffNav()`，刻度轨与工具条都是先清空再重建），重复调用不会叠加节点。
- **仍然修掉的缺口**：未取消的 rAF 本身。除了重复构建，还有一个 v20 才出现的新风险——排队中的回调会在面板已关闭后补加 `visible`，把面板弹回来。修法：`_diffNavFrame` + `_diffOpenGen` 代次守卫。`openDiffPanel` 先 `cancelAnimationFrame` 旧回调再排新的，回调执行时比对代次，不是最新一次直接返回；`closeDiffPanel` 取消待执行回调并递增代次（其 250ms 收尾里的 `clearDiffNav()` 照旧）。
- **性能边界**（YYF 另提「`collectDiffHunks` 最坏可为 20000 行生成数千个按钮，不能一概称为零头」）：v20 已设 `MAX_RAIL_TICKS = 400`，由 `groupHunksForRail` 按序号等分合并（混合类型标 `mixed`，title 明示「第 a–b 处修改（共 N 处，刻度已合并）」），并有 900 处交替修改 → 300 组、覆盖序号 0–899 的用例。
- 回归用例：同一帧 `a.js` → `seg.js` 连点，只有一份控件与一条刻度轨、代码块未被包裹（2 个 `.diff-code`、0 个 `.diff-code-wrap`）、以最后一次为准（标题 `seg.js`、2 个刻度）；无布局时（jsdom `scrollHeight = 0`）刻度轨保持隐藏，不画比例失真的刻度；打开后立刻关闭 → 320ms 后面板既无 `visible` 也无 `open`、刻度轨与控件都隐藏；重开后控件与刻度正常且只有一份。
- **未验证项**：真实浏览器里 macOS 滚动条常显效果与帧率仍无法用 jsdom 证明，需铲屎官实测。

## v20 变更：单一滚动轨道 + 修改刻度轨 + 上/下一处

**背景（YYF 复审 v19 后的设计建议）**：v19 每个代码块一条标尺，导致面板里同时存在两条纵向滚动轨道（面板 + 代码块），且标记依赖原生滚动条着色/并排留白；macOS 悬浮滚动条仍会自动隐藏。v20 改为「单一纵向滚动 + 固定修改刻度 + 上/下一处」。

- **单一滚动轨道**：`.diff-code` 去掉 `max-height: calc(100vh - 200px)` 与 `overflow: auto`（改 `overflow: hidden`），代码块随内容在 `.diff-panel-content` 里展开，只剩面板一条纵向滚动条；随之删除 `.diff-code` 的 `::-webkit-scrollbar` 深色滚动条样式与 `.diff-code.has-lines { min-height: 240px }`（块高度已等于内容高度，最小高度只会堆出空白）。`has-lines` 类保留，作为刻度轨挑选「有已渲染行」代码块的依据。面板滚动条常显样式（`scrollbar-width` + `::-webkit-scrollbar` 12px）保留，`.diff-panel-content` 右内边距 16px→32px 给刻度轨让位。
- **修改处归组**：`collectDiffHunks(container)` 按面板顺序遍历 `.diff-code.has-lines`，把**连续**的 add/del/meta 行聚为一处修改（`{kind, code, first, last, lines}`，`kind` 取首行类型），因此跳转天然跨片段、仅末尾换行的 meta 也是一处；无渲染行（预算耗尽）的块不产生刻度，即"不画无法到达的刻度"。
- **刻度节点上界**：`groupHunksForRail(hunks, MAX_RAIL_TICKS = 400)`——交替修改可产生上千处，超上限时按顺序等分合并（`{start,end,kind}`，同组混合类型 → `kind: "mixed"` 用绿红双色渐变），保证刻度节点数 ≤ 400；合并组的 `title` 明示「第 a–b 处修改（共 N 处，刻度已合并）」。
- **刻度轨与视口指示器**：`$diffRail`（`.diff-rail`，面板内 `position: absolute; right: 16px; width: 10px`，`[hidden]{display:none}`）由 `setupDiffPanel` 建一次；`buildDiffNav` 里 `scale = clientHeight / scrollHeight`，刻度 `top = (code.offsetTop + first.offsetTop) × scale`、`height = max(3px, 该处高度 × scale)`，全部用**布局后**的坐标，所以长行换行、片段变高都会反映到位置；`.diff-rail-viewport` 画当前视口（`top = scrollTop × scale`、`height = max(8px, clientHeight × scale)`，`pointer-events: none`）。
- **工具条与当前处**：`.diff-nav`（`position: sticky; top: 0`，插在面板内容最前面、度量前插入以免偏移失真）含「上一处 / i/N / 下一处」；`gotoDiffHunk(i)` = `centerDiffLine(container, hunk.first)` + `setDiffNavIndex(i)`（越界钳制），当前处的所有行加 `.diff-line.diff-current`（`box-shadow: inset 3px 0 0 #4a6cf7`），对应刻度加 `.active`；打开面板即 `gotoDiffHunk(0)`。`syncDiffNavToScroll()` 以视口中线为准取最后一个已越过的修改处，由 rAF 节流的 passive `scroll` 监听驱动。
- **居中逻辑简化**：只剩一条滚动轨道后，`centerDiffLine` 的目标位置就是 `code.offsetTop + target.offsetTop`，`scrollTop = max(0, top - (clientHeight - lineHeight)/2)`；v18/v18.1 的「内层居中 + 外层再按目标行居中」两步合成一步，`centerFirstDiffChange` 删除。
- **时机与清理**：`openDiffPanel` 在加 `open` 之后的 `requestAnimationFrame` 里调 `buildDiffNav()`（此时才有 `scrollHeight/clientHeight`），随后才加 `visible`；`openDiffPanel` 开头与 `closeDiffPanel` 收尾都调 `clearDiffNav()`（移除 scroll 监听、删工具条、撤 `diff-current`、清空并隐藏刻度轨）；`window.resize` 经 rAF 合并后调 `rebuildDiffNav()`，重建时保留 `scrollTop`，用户不会被甩回顶部。无修改处或无布局（`scale <= 0`）时不显示刻度轨。
- **保留项**：渲染预算不变（单块 12000 行 / 面板 20000 行），截断提示不变（`未渲染该块…` / `仅渲染前 N 行…面板渲染总行数上限…` / `…单个 diff 块最多渲染 12000 行…`），行号仍由 CSS 计数器生成、零额外节点。
- 回归用例（`test-file-diff-display.js`，共 166 项）：`centerDiffLine` 按 `块偏移 + 行内偏移` 居中（1120 → scrollTop 880）、无目标/目标不在块内返回 `null`；`collectDiffHunks` 跨片段顺序、连续 del+add 合一处、meta 单独一处、空容器 0 处；`groupHunksForRail` 900 处 → 300 组且覆盖 0–899、混合组标 `mixed`、未超上限不合并；面板内 4 处修改（23 行文件改 2 处 + meta-only 片段 + 长行片段 + 预算耗尽片段）→ 恰好 4 个刻度、预算块 0 刻度、`scale=0.25` 下 `top` 分别 60/125/155/215px（215px 证明长行换行 60px 已计入）、刻度类名 `del/meta`、`title` 给序号；工具条是面板内容第一个子节点、打开即 `1/4` 且 `scrollTop=100`、当前处 2 行带 `diff-current`、对应刻度 `.active`；下一处 → `2/4`/`scrollTop=360`；点第 4 个刻度 → `4/4`/`scrollTop=720`（跨片段）；首末处再点不越界；点 meta 刻度 → 高亮 meta 行、`scrollTop=480`；`scrollTop=700` + `scroll` → 视口 `top=175px/height=75px`、序号同步为 `3/4`；`clientHeight` 300→600 后派发 `resize` → 刻度按 0.5 重算（`top=120px`）、`scrollTop` 保持 700、工具条只剩一个、序号按新中线恢复为 `4/4`；`clearDiffNav()` → 工具条移除、刻度轨清空并隐藏、高亮撤销、scroll 监听失效；无修改 / 全被预算截断 → `buildDiffNav()` 返回 `null` 且刻度轨隐藏；样式源码断言覆盖 `.diff-code` 无 `max-height` 且 `overflow: hidden`、旧 `.diff-code-wrap`/`.diff-ruler` 已删、`.diff-rail` 绝对定位 + `[hidden]`、刻度三色 + `mixed` 渐变、视口 `pointer-events: none`、`.diff-nav` 吸顶、`.diff-line.diff-current` 高亮条、面板滚动条常显。
- **未验证项**：真实浏览器里的滚动手感（单一轨道 + 吸顶工具条 + 刻度轨与原生滚动条并排的观感）、刻度 10px 宽是否好点、resize 重建时机、20000 行面板的打开耗时，仍需铲屎官确认；jsdom 断言只覆盖计算与样式规则存在。

## v19 变更：滚动条常显 + 概览标尺（修改位置导航）

> 已被 v20 取代：每块一条标尺 + 代码块内滚动的做法改为「单一滚动轨道 + 面板级刻度轨 + 上/下一处工具条」，`.diff-code-wrap` / `.diff-ruler*` / `centerFirstDiffChange` 均已删除。以下仅存档设计过程。

**需求（铲屎官）**：尺寸合适，但看完一处修改找不到下一处；希望滚动条显示出来，并像 VSCode 那样在滚动条处标记有修改的位置。

- **滚动条常显**：macOS 默认是悬浮滚动条，静止时看不见，无法判断还剩多少内容。给 `.diff-code` 与 `.diff-panel-content` 显式画滚动条：`scrollbar-width: thin` + `scrollbar-color`（Firefox），`::-webkit-scrollbar{width:12px}` + track/thumb（Chrome/Safari，同时强制切回经典常驻滚动条）。代码区用深色（`#4b5563` on `#161b22`），面板用浅色。
- **概览标尺**：新增 `collectDiffHunks(code)`（连续的 add/del/meta 行聚为一处修改）、`buildDiffRuler(code, container)`、`buildDiffRulers(container)`、`rebuildDiffRulers()`、`clearDiffRulers()`。标尺是代码块的兄弟节点：`buildDiffRuler` 把 `.diff-code` 包进 `.diff-code-wrap`（`position: relative; padding-right: 14px`），标尺 `.diff-ruler` 绝对定位在右侧 10px 宽的条带里，因此不随内容滚动、也不压住代码块自己的滚动条（滚动条在 14px 留白的左侧）。
- **标记与视口**：每处修改一个 `.diff-ruler-mark`（`<button type="button">`，按该处首行类型着色：add 绿 / del 红 / meta 黄），`top = lineOffsetTop × clientHeight / scrollHeight`、`height = max(3px, 该处高度 × 同比例)`，`title` 为「第 i/N 处修改，点击定位」，点击调用 `centerDiffLine(container, 该处首行)`（与打开时定位共用同一套居中逻辑）。另有 `.diff-ruler-viewport` 指示当前视口（`top = scrollTop × scale`、`height = max(8px, clientHeight × scale)`），由 `code` 的 `scroll` 事件（passive）驱动，`pointer-events: none` 以免挡住标记点击。
- **时机与清理**：标尺依赖布局，必须在 `openDiffPanel` 的 `requestAnimationFrame` 里、`centerFirstDiffChange` 之前构建；`openDiffPanel` 开头与 `closeDiffPanel` 收尾都调用 `clearDiffRulers()`（移除 scroll 监听并把 `.diff-code` 从 wrap 里拆回来）；`setupDiffPanel` 注册 `window.resize` → `rebuildDiffRulers()`，因为标记是按构建时的 `clientHeight` 换算成 px 的，窗口变化后必须重算。无布局（jsdom / `scrollHeight === 0`）或无修改行时不生成标尺。
- **居中逻辑重构**：`centerFirstDiffChange` 拆出 `centerDiffLine(container, target)`，外层基准从 `code.offsetTop` 改为 `wrap.offsetTop + code.offsetTop`（有 wrap 时 `code.offsetTop` 以 wrap 为参照），无 wrap 时行为与 v18.1 一致。
- **代价**：每个有行的代码块多一个 wrap + 一个标尺容器 + 每处修改一个按钮节点（远小于行节点数量级）；每个块一个 `scroll` 监听，只在滚动该块时触发。
- 回归用例：23 行文件改第 10、22 行 → 25 行 diff 聚为 2 个标记；stub `scrollHeight=500 / clientHeight=250` 后标记 `top=100px/height=20px` 与 `top=230px`；标记带 `del` 类与「第 2/2 处修改」提示；视口指示器初始 `top=0/height=125px`；点击第二个标记 → `scrollTop=345`（460-(250-20)/2）；`scrollTop=100` + 派发 `scroll` → 视口 `top=50px`；`clearDiffRulers()` 后代码块回到原父节点且无 `.diff-ruler`；「无内容变化」块返回 `null`；样式源码断言覆盖 `::-webkit-scrollbar` 常显、wrap/标尺定位、标记配色、视口 `pointer-events: none`。
- **未验证项**：真实浏览器里滚动条观感、14px 留白是否够、标尺与滚动条并排的实际视觉效果，以及窗口缩放后重建是否及时，仍需铲屎官确认。

## v18 变更：行号与打开即定位第一处修改

**需求（铲屎官）**：打开文件 diff 时滚轮自动移动到第一处修改处并显示到窗口中心，同时显示行号。

- **自动定位**：新增 `centerFirstDiffChange(container)`（`public/app.js`），取容器内第一个 `.diff-line.add, .diff-line.del, .diff-line.meta`（仅末尾换行变化时 meta 行就是那一处修改），在其所属 `.diff-code` 上按 `scrollTop = offsetTop - (clientHeight - offsetHeight) / 2` 居中；随后按 `code.offsetTop + target.offsetTop - code.scrollTop` 求目标行在外层内容中的位置，让**目标行**（而非代码块顶部）在 `.diff-panel-content` 视口内居中。v18.1（YYF 复审 P2）修正：此前只判断代码块顶部是否在外层视口内，内层居中后目标行仍可能落在视口下方（外层 `clientHeight=500/scrollTop=0`、块 `offsetTop=490/clientHeight=400`、行 `offsetTop=1000/offsetHeight=20` → 内层 810、目标行在外层 680px 处，但块顶 490 ≤ 500 判为可见而不滚）。`openDiffPanel` 在 `open` 之后的 `requestAnimationFrame` 里调用（此时才有布局），随后才加 `visible`；容器无高度（jsdom / 未布局）时跳过外层滚动。
- **参照系**：`.diff-code` 与 `.diff-panel-content` 补 `position: relative`，否则 `offsetTop` 会以更外层的定位祖先为基准，居中计算失真。
- **行号**：用 CSS 计数器而非 DOM 节点——`.diff-code { counter-reset: diff-old diff-new }`，`.diff-line.ctx` 同时推进两个计数器、`.del` 只推进 `diff-old`、`.add` 只推进 `diff-new`，行号由 `.diff-line::before` 输出为「修改前 / 修改后」（缺侧用 `-`，meta 行为空）。`.diff-line` 改 `display: flex` + `gap: 10px`，`::before` 是 `width: 12ch`、`text-align: right`、`user-select: none` 的定宽列，正文换行落在自己的 flex 项内、不会挤到行号下方。因为 diff 覆盖整份文件内容，计数器值即真实文件行号；被预算截断的块只渲染前 N 行，编号仍从 1 连续。
- **为何不用 span 装行号**：面板预算是 12000/20000 行，每行再加 1–2 个节点会把同屏节点数放大 2–3 倍，正是 v12 起一直在防的卡顿面；CSS 计数器零额外节点，且 jsdom 下可用源码级断言覆盖。
- **图例**：面板有片段时在顶部加一条 `.diff-note.diff-legend`「行号：修改前 / 修改后（- 表示该行在对应文件中不存在）」，避免两侧行号含义靠猜；`.diff-legend + .diff-seg-label { margin-top: 0 }` 保持原有紧凑间距。
- **未验证项**：真实浏览器里的居中效果、行号列宽（12ch 容纳到 5 位数 + 分隔符）与打开耗时仍未实测，需铲屎官在浏览器确认。
- 回归用例：a.js 面板第一处修改为删除行；stub `clientHeight=400 / offsetTop=1000 / offsetHeight=20` 后 `centerFirstDiffChange` → 内层 `scrollTop=810`；仅 meta 行的块定位到 meta 行；空容器返回 `null`；外层部分可见场景（外层 `clientHeight=500`、块 `offsetTop=490`）→ 内层 810、外层 `scrollTop=440`（目标行居中）；`.diff-line` 无子元素（行号不建节点）；面板含行号图例；样式源码断言覆盖 `counter-reset`、三类 `counter-increment`、三条 `::before content`、`display: flex` + `width: 12ch`、两处 `position: relative`。

## v17 变更：面板只保留净 Diff

**需求（铲屎官）**：文件修改记录打开后不需要「逐次操作明细」，且净 Diff 窗口要更大。

- `openDiffPanel` 不再渲染明细区：删除 `逐次操作明细 · N 条` 标题、`<details class="diff-change-block">` 懒渲染分支与 `detailBudget`；面板内容由片段标签 + diff 代码块 + 提示组成。`summarizeFileChanges` 的返回值随之不再携带 `ordered`（仅内部用于排序与 uncovered 计数）。
- 明细区消失后，面板同屏只剩片段区一份预算，因此上调：`MAX_DIFF_RENDER_LINES` 5000→12000（净 Diff 单段可见行数 2.4 倍）、`MAX_PANEL_RENDER_LINES` 6000→20000。同屏 `.diff-line` 上界由 12000（两份 6000）变为 20000。
- 面板尺寸放大：`.diff-panel` 宽 560px→920px（`max-width: 96vw`），`.diff-code` `max-height` 420px→`calc(100vh - 200px)`；删除已无引用的 `.diff-change-block` / `.diff-change-head` / `.diff-tool-badge` / `.diff-change-index` / `.diff-change-time` 样式。
- v17.1（YYF 复审 P2）：`min-height: 240px` 从通用 `.diff-code` 移到 `.diff-code.has-lines`，`buildDiffCodeBlock` 仅在 `shown > 0` 时加 `has-lines` 类。否则预算耗尽、只剩一行「未渲染该块」提示的片段也会各占 240px（60 段场景 35 个空块 ≈ 8400px 空白滚动区）。
- 文案同步去掉对明细的引导与承诺：面板总预算提示不再说「逐次操作明细另有独立预算，可按需展开」，单块截断汇总不再说「被截去的尾部在逐次操作明细中同样不会显示」，无快照提示不再说「下方明细顺序仅为提示」。
- **代价（明示）**：顺序未知（`orderUnknown`）与无快照记录的场景，此前还能靠明细看到单条 before/after，现在面板只给出文字结论，不再有任何逐条内容可看；被单块/面板预算截掉的尾部同样无处可看。
- 回归用例：面板全文不含「逐次操作明细」、无 `.diff-change-block` 节点；单块 15000 行 → 渲染 12000 且归因为单块上限；60 段 × 800 行 → 面板恰 20000 行、35/60 片段未完整显示；混合场景（13000 + 3000×4 行）→ 面板 20000 行、`2/5` 面板截断与 `1/5` 单块截断并存；60 段场景中 35 个空块不带 `has-lines`、25 个有行的块都带，通用 `.diff-code` 规则不含 `min-height`，`{ left: 0 }` 的块 `renderedLines=0` 且无 `has-lines`。

## v16 试用：放开编辑快照的 80KB 预算

编辑工具现在读取完整的修改前后文本，不再因为文件大小提前标记 `oversized`。`/api/tool-result` 单独接受最多 100MB 的 JSON 请求体，其他接口仍沿用默认 100KB；若回报被拒（例如超出传输上限），原有降级回报仍会记录为无快照操作。LCS 计算预算从 25 万放宽到 1000 万单元格，使当前约 2,000–2,900 行的文件可计算增删统计；面板单块渲染上限从 1500 行放宽到 5000 行，使当前常见的单文件 Diff 可完整看到；每区 6000 行的面板总预算保留，多段仍会截断。

旧聊天日志中已经标记 `oversized` 的操作没有保存前后内容，不能在刷新后补算 Diff；只有此改动生效后新执行的编辑才会产生大文件快照。测试覆盖超过旧 80KB 预算的前后内容回报、日志写入和执行后缺失文件的分类。

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
2. 点击目录中的文件，右侧滑出侧边面板，展示净 Diff（带链完整性校验）；v17 起不再展示逐次操作明细。

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

- 内容不可得（hash 失败 / 读取失败 / 执行后文件已不存在，snapshotError），或回报被拒后降级为无快照记录（v16 之前还包括超过 80KB 预算的 oversized）：permission-server 不上报内容，也不上报 added/removed（行数差不能推出增删行）；前端显示「未计算行级 Diff」，统计显示「未知」。
- 有内容但 LCS 单元格 >10000000（v16 放宽，原 250000）：前端降级，同样显示「未计算行级 Diff」+「未知」，不使用任何推算数字（v2 中"使用后端 stats"的表述作废——该分支后端本就不上报 stats）。
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
| `permission-server.js` | Edit input 补 `replace_all`；三个编辑工具快照执行；POST /api/tool-result（v16 起不再限制快照大小，被拒仍降级重试） |
| `server.js` | `toolResultCorrelations` 关联表；`POST /api/tool-result`（校验 + 一次性消费 + 写回 execution + SSE permission-executed；v16 起该路由单独使用 100MB JSON 请求体上限） |
| `public/index.html` | `#diff-panel` 侧边面板节点（已完成） |
| `public/app.js` | state（fileChanges / permRequestIndex / replyByThinking）、聚合与链校验、`orderFileChanges` 快照链重建顺序（不可判定 → 顺序未知）、LCS diff（行语义 + meta 行 + 降级标注）、目录 upsert 渲染、侧边面板（v17：仅净 Diff 片段区，无逐次明细）、SSE permission / permission-resolved / permission-executed / reply 钩子、loadHistory 钩子（含从历史审批重建 permRequestIndex） |
| `public/style.css` | 目录样式、侧滑面板（v17：宽 920px、代码区 `calc(100vh - 200px)`）、diff 行高亮（add 绿 / del 红 / ctx 灰）、拆段与降级标注样式；v17 删除 `.diff-change-*` / `.diff-tool-badge` |

## 5. 已知限制

1. 存量历史（无 execution）本期不展示。
2. Bash 改文件不覆盖；净 Diff 拆段处只标注不追因。
3. 回报 POST 失败 = 漏记（明示缺口，无重试）。
4. 无快照记录（回报被拒、内容读取失败、执行后文件已不存在；旧日志还包含 v16 之前 80KB 预算产生的 oversized 标记）与 LCS 降级分支无行级 diff，统计「未知」。
5. 孤儿 permission 记录（messageId 为空）不聚合。
6. 快照反映工具执行时点，不回读当前磁盘内容。
7. 末尾换行状态变化只以 meta 行提示，不计入增删统计。
8. 同文件快照状态重复或成环（如改回原内容）时顺序不可判定：标「顺序未知」，不出净 Diff 与合计；v17 起面板只给出文字结论，不再有逐次明细可看。
9. 同文件混有无快照记录时，其相对写入位置不可证：片段只标「局部快照片段」，不称「净 Diff」，也不归因为「范围外修改」。
10. 单个 diff 块最多渲染 12000 行（`MAX_DIFF_RENDER_LINES`），同一面板的所有片段共受 20000 行总预算约束（`MAX_PANEL_RENDER_LINES`），超出部分只显示提示与省略数量，不显示内容；统计与行级 diff 计算仍基于完整内容。两种截断原因分别归因提示（`truncatedBy = "block" | "panel"`）。v17 删除逐次操作明细后，被截掉的尾部在界面上无处可看。
11. 服务默认只监听 `127.0.0.1`（本机模式无需令牌）；跨设备访问需显式设置 `HOST`，此时 `/api/sessions`、`/api/history`、`/api/events`、静态资源与 SSE 统一由 `ACCESS_TOKEN` 门禁保护（回环请求免令牌），方案见 `docs/plans/2026-10-10-cross-device-access-token.md`。剩余风险：明文 HTTP 传输、单令牌无权限分级、无速率限制与吊销。

## 6. 验收用例

1. Edit 成功：目录出现、净 Diff 与统计正确。
2. Edit 失败（old_string 不存在）：execution.status=error，不计入。
3. Edit replace_all：input 含 replace_all，快照 diff 与真实文件一致。
4. 同文件多次 Edit（连续快照）：合并为一段净 Diff（v17 起不再提供逐条明细）。
5. 同文件两次 Edit 之间被 Bash/用户修改（快照不连续）：拆段 + 范围外修改标注。
6. before===after 的成功操作：不进入目录。
7. Write 覆盖已有文件 / 新建文件：diff 分别为真实对比 / 全新增。
8. NotebookEdit：JSON before/after diff 正确。
9. 无快照记录（回报被拒、内容读取失败、执行后文件已不存在，含旧日志遗留的 oversized 标记）与 LCS 降级：显示「未计算行级 Diff」「未知」，无虚假 +/-。
10. /api/tool-result 重复回报、requestId 不存在、toolName 不匹配：分别 404/404/400，日志不被二次写入。
11. permission-executed 晚于 reply 到达：目录补挂/刷新正确。
12. 会话切换 / SSE resync：状态重建，无串会话、无重复。
13. thread 深层回复与 mcp-tool reply：目录正确挂载。
14. 路径前缀边界：wd=/repo 时 /repo2/a.js 不裁剪。
15. 实时与历史重载一致性：同一轮执行，SSE 实时目录与刷新后一致。
16. 空文件与末尾换行：`null→""` 与 `""→""` 均 0 行无虚假 +1；`"a"→"a\n"`、`"a\n"→"a"` 只出 meta 行且 +/- 为 0；`"a\n"→"a\nb\n"` 正常 +1。
17. 内容读取失败（hash 可得但 read 失败）：回报 snapshotError 而非空快照；`/api/tool-result` 收到 `after: null` 的成功回报返回 400。
18. 执行后文件已不存在（外部删除/竞争，含 before/after 均缺失）：回报 snapshotError 且 changed 未知，既不生成"空文件"有效 Diff，也不被判成"无变化"而丢弃。
19. 刷新期间结果晚到（P1）：审批已入历史快照（allow 或 pending）、回复已渲染，执行结果在重连后到达 → 目录补挂，不永久漏显。
20. 回报到达序与写入序相反（P2）：同文件 x→y→z，第二次修改的回报先到 → 仍为单段净 Diff、+1/-1，不误拆段、不误标"范围外修改"；实时与历史一致。
21. 顺序不可判定：同文件出现重复快照状态或成环 → 目录显示「顺序未知」、面板明示不可判定、不出净 Diff 与合计，也不出逐次操作明细（v17）。
22. 混入无快照操作（同毫秒 + 回报倒序）：面板不得出现「净 Diff」，改标「局部快照片段」并明示不代表文件最终净变化、无快照记录先后无法证明；不误称「范围外修改」；面板不含逐次操作明细（v17）。
23. 无快照记录恰好把快照链切成两段：目录不得标「分段」（仅 `uncovered === 0 && segments.length > 1` 才标），面板仍按多个「局部快照片段」展示。
24. 纯换行大文件（`""→"\n"×40000`）：`computeLineDiff` 不降级但产生 40000 行；单个 diff 块只渲染前 12000 行并提示「仅渲染前 12000 行（共 40000 行）」；面板 `.diff-line` 节点数恰为 12000。
25. 明细区已删除（v17）：上述面板中 `.diff-change-block` 节点数为 0，且全文不含「逐次操作明细」。
26. 默认监听回环：`server.serverInstance.address().address === "127.0.0.1"`，启动日志打印真实绑定地址；跨设备模式（显式非回环 `HOST`）由 `ACCESS_TOKEN` 门禁保护页面、接口与 SSE，详见 `docs/plans/2026-10-10-cross-device-access-token.md` 的 12 条用例。
27. 多段面板总预算：同文件 60 段互不连续快照链（每段 400 行全量替换 → 每段 800 条 diff 行，合计 48000 行）→ 面板 `.diff-line` 恰为 20000、60 个片段标签全部保留、提示含「片段区已达到面板渲染总行数上限 20000」与「35/60 个片段未完整显示」、被跳过的块含「未渲染该块」，且不含任何明细相关文案。
28. 截断原因归因：单块 15000 行且面板总预算未耗尽 → `renderedLines=12000`、`budget.left=8000`、`truncatedBy="block"`，提示为「单个 diff 块最多渲染 12000 行」且不出现「面板渲染总行数上限」；面板汇总为「1/1 个片段由单块渲染上限 12000 行截断」，不再引导去看逐次明细。
29. 混合截断原因：5 段（首段 13000 行、后四段各 3000 行）→ `truncatedBy` 依次 `block, null, null, panel, panel`，面板 20000 行；两条汇总并存且不矛盾（「2/5 个片段未完整显示」与「1/5 个片段由单块渲染上限 12000 行截断」，不出现「面板总预算未用尽」）。
30. 空块占位样式（v17.1）：60 段场景里 35 个预算耗尽的空块不带 `has-lines`（不撑 240px 最小高度），25 个有行的块都带；通用 `.diff-code` 规则不含 `min-height`；`buildDiffCodeBlock(diff, { left: 0 })` → `renderedLines=0` 且无 `has-lines`。
31. 打开即定位（v18/v18.1）：面板第一个 `.diff-line.add/.del/.meta` 在其 `.diff-code` 内居中——`clientHeight=400`、`offsetTop=1000`、`offsetHeight=20` 时内层 `scrollTop=810`；仅末尾换行变化时定位到 meta 行；无任何 diff 行时返回 `null` 不滚动；外层部分可见（外层 `clientHeight=500`、块 `offsetTop=490`）时外层 `scrollTop=440`，即目标行在面板视口居中，而不是只保证代码块顶部可见。
32. 行号（v18）：`.diff-code` 重置 `diff-old`/`diff-new` 计数器，ctx 双推进、del 只推进旧号、add 只推进新号，行号由 `::before` 以「旧 / 新」输出（缺侧 `-`、meta 行空）；`.diff-line` 内无子元素（不新增节点），面板顶部有「行号：修改前 / 修改后」图例。
33. 概览标尺（v19，已被 v20 取代）：每块一条标尺 + 代码块内滚动的实现已删除（`.diff-code-wrap` / `.diff-ruler*` / `buildDiffRuler(s)` / `clearDiffRulers` / `centerFirstDiffChange`）；保留下来的只有 `.diff-panel-content` 滚动条常显。
37. ↑/↓ 与文件路径同一行（v23）：index.html 源码断言 `#diff-panel-sub` 与 `#diff-nav` 同处一个 `.diff-panel-subrow`；样式断言 `.diff-panel-subrow { display: flex }`、`.diff-panel-sub { flex: 1 1 auto }`、`.diff-nav` 不再自带 `padding` 且 `[hidden]{display:none}` 仍在、`.diff-panel-header h3` 不带 `flex`；按钮文本仍为 ↑/↓。
36. 导航按钮位置与符号（v22，行位置已被 v23 取代）：控件曾是标题行下面独立的一行，按钮文本 ↑/↓，`.diff-nav { justify-content: flex-end }` + `[hidden]{display:none}`，且 `.diff-panel-header h3` 不再带 `flex`。
35. 代次守卫与符号按钮（v20.1/v21）：同一帧连点 `a.js`→`seg.js` 只有一份 `.diff-nav` 与一条 `.diff-rail`、`.diff-code` 2 个且无 `.diff-code-wrap`、标题为 `seg.js`、刻度 2 个；无布局时刻度轨隐藏；打开后立刻关闭 → 320ms 后面板无 `visible`/`open`、刻度轨与控件都隐藏；重开后控件 `hidden=false`、刻度 1 个。控件位于 `#diff-panel-title` 与 `#diff-close-btn` 之间（index.html 源码断言），按钮文本 ⬆️/⬇️，序号节点即 `nav.counter`；`.diff-nav { margin-left: auto }` + `.diff-nav[hidden] { display: none }` + `.diff-panel-header h3 { flex: 1 1 auto }` 实现右对齐。
34. 修改刻度轨与上/下一处（v20）：`.diff-code` 无 `max-height` 且 `overflow: hidden`，面板内容是唯一纵向滚动轨道；`centerDiffLine` 按 `code.offsetTop + target.offsetTop` 居中（1120 → `scrollTop=880`），无目标或目标不在块内返回 `null`；`collectDiffHunks` 跨片段按面板顺序收集，连续 del+add 合一处、meta 单独一处、空容器 0 处；`groupHunksForRail` 把 900 处合并为 300 组（≤ `MAX_RAIL_TICKS=400`）且覆盖序号 0–899、混合组标 `mixed`、未超上限不合并；4 处修改（23 行文件改 2 处 + meta-only + 长行换行 + 预算耗尽）→ 恰好 4 个刻度、预算块 0 刻度，`scale=0.25` 下 `top` 为 60/125/155/215px（215px 证明长行换行的 60px 已计入布局坐标），刻度带 `del`/`meta` 类与「第 1/4 处修改」提示；工具条是面板内容第一个子节点，打开即 `1/4` + `scrollTop=100` + 当前处 2 行 `diff-current` + 对应刻度 `.active`；下一处 → `2/4`/`360`；点第 4 个刻度跨片段 → `4/4`/`720`；首末处再点不越界；点 meta 刻度 → 高亮 meta 行/`480`；`scrollTop=700` + `scroll` → 视口 `175px`/`75px`、序号 `3/4`；`clientHeight` 300→600 + `resize` → 刻度按 0.5 重算（`120px`）、`scrollTop` 保持 700、工具条仅一个、序号恢复 `4/4`；`clearDiffNav()` → 工具条移除、刻度轨清空并隐藏、高亮撤销、scroll 监听失效；无修改或全被预算截断 → `buildDiffNav()` 返回 `null`；样式源码断言覆盖旧标尺样式已删、`.diff-rail` 绝对定位 + `[hidden]`、刻度三色 + `mixed` 渐变、视口 `pointer-events: none`、`.diff-nav` 吸顶、`.diff-line.diff-current` 高亮条。

## 7. 实施进度

- [x] `public/index.html`：`#diff-panel` 面板节点；v21 加 `#diff-nav`（`#diff-nav-prev` / `#diff-nav-count` / `#diff-nav-next`，默认 `hidden`），v22 移到标题行下面独立一行并把符号定为 ↑/↓，v23 改为与 `#diff-panel-sub` 同处 `.diff-panel-subrow` 一行。
- [x] `public/app.js`：`$diffPanel` 等 DOM 引用。
- [x] `permission-server.js`：Edit input 补 `replace_all`；三个编辑工具快照执行（v16 起不限快照大小 + sha256 changed 判定，形态判定委托 `classifySnapshot`）+ 回报。
- [x] `lib/tool-result-reporter.js`：回报模块（状态码检查、413 降级 oversized 重试、流式 hashFile 区分 missing/error、`classifySnapshot` 纯函数：hash 失败/执行后文件缺失（无论执行前是否存在）/读取失败 → snapshotError 且 changed 未知，超预算 → oversized，否则有效快照）。
- [x] `server.js`：`toolResultCorrelations`（仅审批通过时注册，2h TTL、一次性消费）；`POST /api/tool-result`（toolName/ok/filePath/快照字段强校验，`after` 必须为字符串，snapshotError/oversized 免快照）；`execution`（含 changed、服务端单调 seq）写回日志；SSE `permission-executed`；v12 默认绑定 `HOST ?? "127.0.0.1"`、启动日志打印真实地址、非回环时输出访问边界告警。
- [x] `public/app.js`：聚合（仅 allow+success 且 changed≠false，基线序 finishedAt→seq）、`orderFileChanges`（按快照连续性重建顺序，重复状态/成环 → orderUnknown）、LCS diff（`splitDiffLines` 行语义 + 末尾换行 meta 行 + 降级标注）、净 Diff 链校验拆段、目录 upsert 渲染（.msg-model 之后，含「顺序未知」态；「分段」仅在 uncovered===0 且多段时标注）、侧栏面板（区分无快照/snapshotError/顺序未知 文案，无快照记录参与时片段降级为「局部快照片段」，v17 起只渲染净 Diff 片段区、不再有逐次明细与懒渲染，单块渲染上限 `MAX_DIFF_RENDER_LINES=12000`、面板级总预算 `MAX_PANEL_RENDER_LINES=20000`（同屏仅此一份），截断原因经 `truncatedBy` 区分并分别提示单块上限／面板预算耗尽；v18 新增 `centerFirstDiffChange` 在 `openDiffPanel` 的 rAF 内把第一处增删行滚到代码区中心，并在有片段时插入行号图例）、SSE 钩子、loadHistory 钩子（含从历史审批重建 permRequestIndex）、补挂机制；v20 新增 `centerDiffLine`（单轨道居中）、`diffLineKind` / `collectDiffHunks` / `groupHunksForRail`（`MAX_RAIL_TICKS=400`）、`buildDiffNav` / `setDiffNavIndex` / `gotoDiffHunk` / `syncDiffNavToScroll` / `rebuildDiffNav` / `clearDiffNav`，`setupDiffPanel` 建 `.diff-rail` 并注册 rAF 合并的 `resize` 重建，删除 `centerFirstDiffChange` 与 v19 的每块标尺函数；v20.1 加 `_diffNavFrame` / `_diffOpenGen` 代次守卫（open 取消旧 rAF、close 递增代次并取消）；v21 改引用 index.html 的 `$diffNav` / `$diffNavPrev` / `$diffNavCount` / `$diffNavNext`，`buildDiffNav` 只切 `hidden`、`clearDiffNav` 只隐藏，按钮监听移到 `setupDiffPanel`。
- [x] `public/style.css`：目录、侧滑面板（v17：宽 920px / `max-width: 96vw`，`.diff-code` `max-height: calc(100vh - 200px)`，`min-height: 240px` 仅作用于 `.diff-code.has-lines`）、diff 高亮（含 `.diff-line.meta`）、拆段/降级标注样式；v18：`.diff-code`/`.diff-panel-content` 补 `position: relative`，行号用 `counter-reset` + 三类 `counter-increment` + `.diff-line::before`（12ch 定宽 flex 列），`.diff-legend` 图例；v19：滚动条常显（`.diff-code` / `.diff-panel-content` 的 `scrollbar-width` + `::-webkit-scrollbar`）、`.diff-code-wrap` 14px 留白、`.diff-ruler` / `.diff-ruler-mark`（add/del/meta 三色）/ `.diff-ruler-viewport`；已删除无引用的 `.diff-change-*` 与 `.diff-tool-badge`；v20：`.diff-code` 去掉 `max-height`/`overflow: auto` 与深色滚动条样式（改 `overflow: hidden`）、删除 `.diff-code.has-lines { min-height }` 与 `.diff-code-wrap` / `.diff-ruler*`，`.diff-panel-content` 右内边距 32px，新增 `.diff-rail`（绝对定位 + `[hidden]`）/ `.diff-rail-tick`（add/del/meta/mixed/active）/ `.diff-rail-viewport` / `.diff-nav` / `.diff-nav-btn` / `.diff-nav-count` / `.diff-line.diff-current`；v21：`.diff-nav` 从 sticky 工具条改为右对齐控件（`[hidden]{display:none}`、24×24 符号按钮）；v22：控件独占标题下一行（`justify-content: flex-end`），按钮 `font-size: 14px` / `color: var(--text)`，并回退 v21 给 `.diff-panel-header h3` 加的 `flex`；v23：新增 `.diff-panel-subrow`（flex 行，接管原 `.diff-panel-sub` 的 `padding`/底色/`border-bottom`），`.diff-panel-sub` 改 `flex: 1 1 auto; min-width: 0`，`.diff-nav` 去掉 `padding`/底色/`justify-content` 只留 `flex-shrink: 0`。
- [x] 测试：`test-file-diff-display.js` 180 项（含回报倒序的实时/历史一致性、刷新后晚到结果补挂（allow 与 pending 两种）、重复快照状态标「顺序未知」、混入无快照记录时面板降级为「局部快照片段」且目录不标「分段」、snapshotError 计入、空文件/末尾换行边界与 meta 渲染、约 2000 行文件的 LCS 增删统计、纯换行 40000 行的单块渲染预算与截断提示、v17 面板无逐次明细节点与文案、60 段多片段的面板级总预算与省略数量提示、空块不撑最小高度（has-lines）、单块 15000 行时截断原因归因为单块上限而非面板预算、混合原因（block+panel 同屏）文案不矛盾、v18 打开即居中定位第一处修改（含外层视口按目标行居中、meta-only 定位）与行号计数器/图例/零额外节点；v19 `centerDiffLine` 抽出复用、`collectDiffHunks` / `buildDiffRuler(s)` / `rebuildDiffRulers` / `clearDiffRulers` 概览标尺与视口指示器、open/close/resize 三处生命周期钩子；v20 单一滚动轨道居中、修改处归组与刻度上界、刻度轨定位/着色/点击跳转、上一处-下一处与序号同步、meta 与长行换行片段、预算截断不画刻度、resize 重建保留 `scrollTop`、`clearDiffNav` 清理，以及 `.diff-code` 无 `max-height`/旧标尺样式已删等样式断言；v20.1 同一帧连续打开与「打开后立即关闭」的代次守卫回归；v21 符号按钮 ⬆️/⬇️、控件位于标题行且右对齐、`hidden` 生命周期与 index.html 源码断言）、`test-tool-result.js` 41 项（含 seq 单调、snapshotError 200、`after: null` → 400、默认监听回环、超过旧 80KB 预算的大快照回报）、`test-tool-result-reporter.js` 29 项（含 missing/error 区分、classifySnapshot 形态分类与 after 缺失／两侧均缺失回归、大文本仍保留快照）全部通过；既有 test-tool-records-fold（26）/ test-thinking-restore（56）/ test-metric-bar-label（9）/ test-permission-history（20）/ test-permission-context（54）/ test-access-gate（120）无回归。另做 spawn permission-server 走 MCP stdio 的实机端到端复验（Write 新文件 before=null、Edit 快照真实、清空文件 after="" 不误报、失败 Edit 记 error+changed=false、seq 单调）。
