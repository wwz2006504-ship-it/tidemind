> 第30—32步（2026-11-04）：363项完整回归通过，120份原源码/资源未变。四存储记忆门闩、候选host暂停接入及持久待处理重放完成隔离测试；整轮排空/自动回切/生产退回尚未完成，不可实装。见reports/STEP32-DEFERRED-REPLAY-REPORT.md及第30/31步报告。

> 第29步（2026-11-04）：349项完整验收通过，120份原源码/资源不变。HTTP物化worker验证后签收及持久恢复通过；真实传输、四存储权威前沿、自动回切和生产退回仍待完成，不可实装。见reports/STEP29-MATERIALIZER-WORKER-REPORT.md。

> 第28步：342项完整验收通过，120份原源码/资源未变。原权威HTTP签收/票据链路和loopback客户端通过隔离测试；真实worker、自动回切与生产退回尚未接通，不可实装。见reports/STEP28-AUTHORITY-HTTP-REPORT.md。

> 第27步：339项完整验收通过，120份原源码/资源未变。持久签收/交接票据接入原权威库与原交接事务；同机反向增量+签收+交接测试通过。真实传输、自动回切及生产退回未完成，不可直接实装。见reports/STEP27-DURABLE-RECEIPTS-REPORT.md。

> 第26步：333项完整验收通过，120份原源码/资源未变。离线签名增量包及四存储实际重建链路通过；持久回执、真实网络权威、自动回切及生产退回仍待完成，不可直接实装。见reports/STEP26-SIGNED-SYNC-DELTA-REPORT.md。

> 第25步：329项完整验收通过，120份原源码/资源未变。四存储候选准备/恢复选择及真实适配器核对完成；网络增量同步、自动回切和生产退回未完成。见reports/STEP25-CANDIDATE-GENERATION-REPORT.md及reports/DUAL-HOME-WORKLIST.md。

> 当前第24步：323项完整验收通过，120份原源码/资源不变；独立判断日志原插件接线及复合头已在隔离宿主完成，四存储增量同步/崩溃恢复仍待完成，不可直接实装。见reports/STEP24-PROTECTED-AI-MEMORY-REPORT.md。

> 当前第23步：319项通过；统一版本核对接入既有交接入口，独立判断日志未覆盖时生产交接拒绝。真实多存储同步仍待完成，不可实装。详见reports/STEP23-COMPOSITE-HANDOVER-REPORT.md。

> 当前第22步（2026-11-03）：315项通过，110份原源码/资源未变。会话轮换、高推理求助及候选上传准备完成，真实双机与生产退回尚未验收，不可直接实装。见 reports/STEP22-ROUTING-ROLLOVER-REPORT.md。

> 当前（2026-11-03）：第21步完整308项通过，110份原源码/资源未变。原宿主启动接线及任务控制完成隔离验收；实际运行参数准备、生产装配和真实退回尚未完成，不可直接实装。见[当前报告](reports/STEP21-RUNTIME-ENTRY-REPORT.md)。下文为历史记录。

> 当前（2026-11-03）：第20步完整295项通过，原人格自编辑/恢复已改用独立版本，具体profile审阅准备可运行；生产启动绑定和真实退回仍未完成，不能实装。见[当前报告](reports/STEP20-PERSONA-PROFILE-PREP-REPORT.md)及[接续入口](reports/CURRENT-RESUME.md)。下文为历史记录。

> 当前（2026-11-03）：第19步完整283项通过，108份现役源码/资源未变，仍未达到生产实装条件。见[当前报告](reports/STEP19-NATIVE-LIFECYCLE-MEMORY-REPORT.md)与[接续入口](reports/CURRENT-RESUME.md)。以下是历史阶段记录。

> 工作中存档（2026-11-03）：第18步尚未完整回归，不可实装。用户要求明日继续。先读 [接续记录](reports/STEP18-WIP-RESUME.md)。下文为历史已完成版本记录。

# 原潮池既有包接线进度（2026-11-01）

最新阶段（2026-11-03）：第17步候选版图片、工具发送和原CosyVoice接线完成，257项通过，98份现役源码不变。真实QQ、音色试听和生产切换退回尚未验收，不能直接实装。详见[第17步报告](reports/STEP17-MEDIA-COSYVOICE-REPORT.md)。下文为历史记录。

最新阶段（2026-11-02）：第16步组合与合成退回验证完成，233项测试通过，98份现役源码未变。15个原内置模块＋9个自定义模块＋heartbeat可在隔离宿主并用；冷重建保留新增合成记忆且不双发。**已复现媒体及原工具主动发送不兼容，当前不能实装。** 通过包含缺口复现测试，不表示所有功能可用。当前报告：[第16步](reports/STEP16-COMBINATION-RETURN-REPORT.md)。以下为历史记录。

最新阶段（2026-11-02）：第15步将原heartbeat运行时接入隔离宿主，共享休息、预算、原会话和outbox；累计209项通过，56份现役源码不变。旧heartbeat生产交接未执行，完整功能组合与生产退回仍待验收，不能直接替换现役。当前报告：[第15步](reports/STEP15-MANAGED-HEARTBEAT-REPORT.md)。以下为历史记录。

最新阶段（2026-11-02）：第14步隔离接通Minecraft直接注册、模块定时任务与原自主桌面/耳朵主动唤醒。完整201项通过，54份现役源码不变。自主提示使用module-event来源，休息取消原生会话，主人消息先打断自主回合。独立DSH heartbeat、全部功能组合与生产退回仍待验收；未切换现役。当前报告：[第14步](reports/STEP14-MODULE-ACTIVITY-REPORT.md)。下文为历史记录。

最新阶段（2026-11-02）：自定义模块兼容专项26项通过，完整回归185项通过，54份现役源码不变。9个自定义模块使用原源码、合成内存数据与模拟外部服务，并在原模块内核验证加载/卸载。Minecraft直接注册分支、原主动任务托管与生产退回仍待接通，现役未切换。详见[第13步报告](reports/STEP13-CUSTOM-COMPATIBILITY-REPORT.md)。实装前再生成给汐羽的接入说明。下文保留历史记录。

最新进度：第12步（2026-11-02）原host.js隔离启动接线完成，累计153项通过，43份现役源码不变。真实Cordis/会话运行时与原模块/Hub，外围依赖为离线替身；默认自主工具执行。原心跳、其他模块及旧JSON记忆/真实人格绑定仍待接线，现役未启用。详见[第12步报告](reports/STEP12-AURABOT-ENTRY-REPORT.md)。下文为历史阶段记录。

最新进度（2026-11-02）：第11步原模块内核工具装配通过隔离验证，累计145项通过，40份现役源码指纹不变。默认自主执行；较早阶段的逐次授权只保留为可选兼容模式。完整host.js启动入口尚待接入，不能直接替换现役。当前报告：[第11步报告](reports/STEP11-MODULE-HOST-REPORT.md)。下文保留历史记录。

沿用 TideMind-existing-upgrade-2026-10-31 的三个入口、原MemoryStore与memories/FTS表结构。现役不安装、不启停、不改人格/记忆/QQ凭据。

本批完成原store实际变化的原子落库、替代链、撤回、退潮及故障恢复，并接通隔离宿主中的原工具/自动捕获/上下文钩子。**69项验收通过**（含新增第3步15项）。

最新报告：[reports/STEP3-REPORT.md](reports/STEP3-REPORT.md)。此前第1/2步报告为阶段记录。真实Cordis、ToolRuntime、SystemPrompt配合合成会话；不是完整桌面profile或真实QQ会话的验收。

目录：

- TideMind：原包修订副本；原lease/reconcile/API入口保留。
- integration：原store适配、受信批次、宿主绑定和验收runner。
- host/plugin：仅源码的隔离克隆（未含原人格/记忆/凭据）；指纹在host/SOURCE-MANIFEST.json。
- data：仅合成临时库，验收自动创建/清理。
- reports：测试结果与已知失败情形。

命令（在本目录）：

```
python integration/acceptance.py --dry-run
python integration/acceptance.py
python integration/acceptance.py --rollback
```

运行前需要本机原插件源码仍位于 `.dsh/profiles/desktop/node_modules/dsh-memory-layers`，以及安装中的DSH依赖位于 `<DSH_APP_DIR>/resources/app/node_modules/@deepseek-ai`（后者可用TIDEMIND_APP_MODULES覆盖）。若源码版本与克隆指纹不同，验收拒绝执行。Node24.17.0、Python3.11.9为本次实测环境；未验证容器运行。

升级authority默认要求独立受信store签名key。测试使用显式合成key；部署时不能复用。模型和普通聊天agent不能获得该key。测试的legacy兼容开关不能用于部署。

现在可以复现隔离效果；不能拿本包直接替换现役。第3步原Hub出站适配已通过隔离验收，真实QQ未连接。下一步补第4步会话/入站检查点、可信确认及退回演练；实际生产启用仍需完整profile/真实会话映射、原Aurabot写入路径收口、真实QQ、云端与退回验收。

原Aurabot Hub的11个源码依赖只复制到host/aurabot，已去除真实用户数据目录默认值；不含原personas、配置、凭据。验收同时锁定这些原源码的指纹。


## 第 4 步阶段更新（2026-11-01）

累计验收 75 项通过。新增持久化入站交接记录与稳定输入 ID；flush 返回不当作持久证明，不确定消息禁止自动重投。完整恢复、可信副本确认、休息状态迁移和跨机器退回尚未完成。详见 reports/STEP4-ADMISSION-REPORT.md；禁止安装到现役。


## 持久日志核验更新（2026-11-01）

累计 80 项通过。实际安装的 DSH JSONL 持久化组件已接入隔离 Hub；落盘确认前进程中止可在新进程核验，不重复投递。完整现役宿主和跨机器接管仍未启用。当前报告以 reports/STEP4-HISTORY-REPORT.md 为准；较早阶段报告保留为历史记录。


## 真实宿主接线更新（2026-11-01）

89 项通过。新增真实 SessionController/AgentLoop 和宿主重建验收，模型与 QQ 仍为离线替身。已封堵开场摘要误读现役的路径回退，并修复 QQ 来源识别。请使用本次代码包，旧阶段包不要安装。最新边界、只读误读事件及剩余阻塞详见 reports/STEP5-HOST-REPORT.md。生产仍未启用。


## 正常关闭后的本地补交（2026-11-01）

累计 102 项通过。保存原输入与历史锚点，在真实旧 runtime 正常关闭、同一本机监督进程保持关闭证明、新原生会话单写者和新任期就绪后，可按原 ID 补交一次。断电、跨机器、无准确输入或无关闭证明仍停止。默认预演，无新增生产入口。最新报告：reports/STEP6-RECOVERY-REPORT.md。


## 任务与休息检查点（2026-11-01）

累计115项通过。任务和休息状态存于原租约权威库，事件触发四个只读认知阶段；休息取消并等待真实会话停止，检查点与预算跨进程保留。没有启用现役心跳、真实模型或云端，也没有开放 L3/QQ/记忆写入权限。当前报告：reports/STEP7-TASK-REST-REPORT.md。


## QQ能力接口（2026-11-02）

累计131项通过。隔离接口限制模块直连QQ，精确单次工具许可绑定真实执行上下文，普通回复沿用原outbox；隔离OneBot副作用不再从HTTP失败退回WS。真实host/审批界面/心跳入口尚未接线，本机已装服务未刷新。当前报告：reports/STEP9-QQ-CAPABILITIES-REPORT.md。


## 用户工具自主策略（2026-11-02）

按用户最新要求，默认工具自主执行，不逐次人工审批；认知任务保留宿主已有工具，取消统一工具禁用。旧逐次审批/只读模式仅显式可选。累计137项通过，当前报告 reports/STEP10-AUTONOMY-REPORT.md 取代旧报告的默认限权设计。原人格记忆、单主去重、休息预算保持原约定，现役和已装组件未改。
