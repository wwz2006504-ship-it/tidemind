# 现役潮池原位升级：隔离验收交付

日期：2026-10-31。此包沿用原三个入口及现役 memory-layers 表结构。**不包含另起的 memory_engine、memory_cli、bridge 草稿，也不接入它们。** 当前原三个文件、现役库、原影子库、人格、QQ 凭据均未修改；所有写入测试均为临时目录合成数据。

## 原系统结构与兼容基线

- 宿主桌面 profile：`C:\Users\USERNAME\.dsh\profiles\desktop`。真实插件是该 profile 链接的 `dsh-memory-layers 0.1.1`，不是另一套隔离环境里的同版本副本。
- `.dsh\memory-layers\config.json` 指向 `<MEMORY_LAYERS_DIR>`，配置预算2000、maxResults8。
- 保留 `memories` / FTS5 trigram `memories_fts`、原索引/触发器、persona/persona_versions。测试schema从现役sqlite_master只读提取，**没有复制记忆或人格正文**。
- 原检索兼容条件严格锁定：空白分词、长度≥3、OR、BM25、`status='active' AND valid_to IS NULL`。没有把它改成“valid_to尚在未来也注入”。
- 原潮池 `expireTide` 对 episodic 沉淀/退潮、working 到期；不把退潮扩展到 core/semantic/persona。不修改原定时器或保留期。
- Aurabot仍负责人格变量、会话和QQ；原memory-layers已有读取Aurabot记忆的桥。独立 installed ai-memory 与persona-self等模块的启用状态尚未运行时核实，不重复挂载它们。

## 1. 7/8 差异结论

查询 `耳朵 录音 麦克风` 实际 FTS 只有 `"麦克风"`。现役3条、原影子2条。

差异ID：`<MEMORY_ID_REDACTED>`。现役为 episodic / active、valid_to=NULL、superseded_by=NULL，created_at=updated_at=1793482722498；影子按该ID查询为不存在。其余共有结果元数据与内容哈希一致。

分类：**相对当前影子快照的现役新增**。未观察到该差异由withdrawn、superseded或valid_to状态变化造成。这是当前快照差异分类，不宣称证明了影子此前从未有过该ID。

证据：`docs/shadow-difference-evidence.json`、`docs/reconcile-current.json`。仅保存ID、状态、时间和哈希，没有保存正文。

复现：`python manage.py diagnose --dry-run`；实际只读诊断：`python manage.py diagnose`。后者调用修订的原 reconcile.mjs，两库各持有只读事务，报告写本包docs目录，失败返回非零。不会覆盖原 reconcile-report.json。六组双方空结果不算有效召回覆盖。

后续补齐应新建一致性副本并从现役单向接收完整记录、来源和状态，不手工拼一条active记录；本批按要求只查明，没有刷新原影子。

## 2. 在原 lease.mjs 上扩展权威与最终 fencing

原 acquire/renew/release/status 接口保留。修订采用：

- renew/release条件更新；识别 authority 时钟回退；term不恢复旧备份；SQLite FULL同步与锁等待。
- 原 lease.mjs 新增 `serve` 管理传输（只绑定127.0.0.1:5181）。它调用同一个租约实现，**不是另一个租约库或检索服务**。未来跨机器经已认证私有隧道接入同一权威点，不能复制lease.db后各自判权。
- local/cloud凭据绑定主体，HTTP请求自报holder无效；凭据不是QQ凭据。
- `fenced()`：BEGIN IMMEDIATE → 校验holder/term/有效期 → 持久化提交日志/去重预留 → 再校验 → COMMIT。旧任期不能在最终接受点写入。
- 全局revision+hash链及op幂等记录放在权威租约库的扩展表。memory-layers仍用原表结构，副本应用器只把已提交记录应用到原memories表，原FTS触发器正常更新。
- 核心ID和原始数据/人格指纹必须先登记。副本遇到越过日志的修改、不同基线、版本分叉、日志缺口即停止；不覆盖修复。

**边界：权威提交日志是轻量协调/去重元数据，不承担日常聊天或新记忆引擎。** 日常逻辑写者为本机、云端agent只读接收；断电接管后才允许cloud主体提交。若不愿让正常本机提交依赖云端权威可达，就需要另行选择分区策略，不能同时承诺离线可写与严格单主。本批采用权威不可达即停止提交。

## 3. QQ 出站去重

原lease入口扩展库 `tide-gateway.mjs`：稳定channel+eventId+固定reply槽作为去重键；同键不同正文停止。pending → unknown **先落盘** → 调可信QQ transport → 有确认回执才sent。重复、并发、重启不会再次发起同事件尝试；旧任期不能enqueue/dispatch。

ACK丢失或发送中崩溃保持unknown，禁止盲目重发；unknown阻止交接，等待人工/可核验回执处理。这是“每事件至多一次自动发送尝试”，不保证消息一定送达。尚未连接真实QQ transport，因此不宣称现役QQ已获得去重保护。

## 4. 单向同步、故障接管与退回

`local-primary`：本机提交，cloud只读接收已提交日志。交接前核对双方revision、链hash、数据hash、人格/core保护hash和初始基线hash。双方一致、无pending/unknown出站项才允许交接；释放原租约与改变home在同一事务中完成，接收方再申请新term。

反向到local仅允许显式切换流程。发现目标版本更高、源在计划后更新、目标额外写入，一律停止。原人格与core行受到应用器保护，不被增量更新。

突然断电：原租约超时后新holder取得新term；可信管理钩子确认云副本追平并完成基线校验，才改变primary。未尝试发送的pending可接续；unknown不自动处理。可信交接/接管钩子目前是库接口，**没有向普通agent开放远程自报ACK的HTTP路由**。

测试中的往返：本机新增→云接收→交接cloud→cloud撤回该记忆→反向同步→交回local。数据指纹一致，withdrawn状态保留，persona/core指纹不变。

## 命令、dry-run、退回

| 脚本/入口 | 安全预演 | 实际验收或失败退回 |
|---|---|---|
| manage.py | `python manage.py test --dry-run` | `python manage.py test`：合成库自动清理；失败退回 `python manage.py rollback`（此验收不改生产） |
| reconcile.mjs | `node deploy/existing/reconcile.mjs --dry-run` | `python manage.py diagnose`：只读两库；失败保留新报告。退回 `python manage.py rollback`，不补写原影子 |
| lease.mjs | `node deploy/existing/lease.mjs serve --dry-run` | 仅新测试目录可运行serve；失败用 `Stop-Process -Id <本次测试服务PID>` 停该测试服务，保留lease.db/日志，**不要恢复旧任期备份** |
| tidemind-api.mjs | `node deploy/existing/tidemind-api.mjs --dry-run` | 仍是原 /retrieve。测试失败用 `Stop-Process -Id <本次测试API进程PID>` 停止自己的测试实例，原5180实例不动 |

新增 `.mjs` 辅助文件是被原入口导入的库，没有第二套管理CLI或检索入口。测试模块不是部署脚本。

幂等：相同op+相同内容不重复提交；相同事件不重复发送尝试；同步日志重放不重复插入。旧租约请求安全拒绝，不将“再次失败”冒充“原成功响应重放”。API端口冲突仍会报错，不自动杀其他进程。

## Compose硬约束

只允许内部 `tidemind_shadow` 新命名卷，无bind、external卷、宿主socket、设备或特权；现役路径不作为任何挂载源。两个服务均为禁用profile、无网络、只读卷、只运行原入口dry-run。

检查命令：`python manage.py check --dry-run`

当前Compose是离线部署准备，不能直接启动云端服务；本机无Docker，容器/私有隧道/两台真实主机验收尚未执行。不得用override绕过检查挂载现役目录。

## 生产仍需补齐的接线

1. 在隔离宿主对齐实际会话/主体映射；逻辑 agentId 由 TIDEMIND_AGENT_ID 指定，不假定它就是 DSH 运行时 session ID。
2. 原lmem_*、自动捕获、潮池维护和Aurabot写入路径全部纳入统一提交适配；生产未完成前不能声称旧实例物理写不进。不能让旧流程绕过网关。
3. 将真实QQ发送收口到唯一可信transport，agent不持有发送凭据或直接发送旁路；对接稳定OneBot事件ID。
4. 交接ACK必须来自已认证、实际校验数据的副本应用器；当前HTTP没有开放该能力。自动心跳接管监督器、真实Windows关机钩子待实装。
5. 原store约束（norm_hash、去重/替代链等）需在提交前由原store适配器验证。应用阶段遇约束冲突会停止，不能跳过坏日志；尚无生产日志修复工具。
6. 云资源可用后验证持久化存储、私有连接、故障重启、还原流程。迁移/付款仍须用户确认。

上述是明确阻塞，不用另一套记忆系统绕过。原人格与原记忆一直保留；**人格保持原样**。
