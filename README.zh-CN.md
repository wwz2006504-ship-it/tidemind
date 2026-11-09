[English](README.md) | **简体中文**

# TideMind

给长期运行的 AI 智能体做**记忆、人设、自主性**的开源框架。核心是一个"单写入者"的权威机制（带单调递增任期号和围栏事务的 SQLite 租约）、本机与云端备用之间的签名状态同步，以及一个有边界的多步任务调度器。

> 状态：研究性代码。大部分集成测试是针对 Windows 桌面宿主（DSH / Aurabot）写的，需要该宿主的测试在没有宿主时无法运行，下文会标明。

## 与记忆系统、情绪系统的关系
TideMind 是建立在作者自己的记忆系统（"潮池"记忆库，在 `host/plugin` 里附带了一份隔离的测试副本）和作者的情绪设计之上的控制层，不是要取代它们。它补上的是围绕它们的那一部分：本机主、云端备用之间的单写入者、围栏与回退；有边界的多步目标；需要主人批准的"只提议"式自主；以及可审计的情绪与特质层。这里的情绪模块（`tide-affect`、`tide-moods`、`tide-traits`）是按作者的设计重新实现的，不是沿用早期的代码。

## 里面有什么

- `TideMind/`：框架本体，包括租约与权威机制、对账、副本、部署文件和升级测试。
- `integration/`：集成模块和测试。
  - 任务调度：`task-checkpoints.mjs`（观察 → 反思 → 计划 → 验证，带预算、休息开关和取消）、`task-handoff.mjs`、`source-quiescer.mjs`、`runtime-transfer-drain.mjs`。
  - TideMind 3.0 扩展：
    - `tide-goals.mjs`：持久的多步目标，没做完不会被当成完成。
    - `tide-life.mjs`：只"提议"低风险的小事，有安静时段和冷却时间，对方没回就不追着发。
    - `tide-affect.mjs`、`tide-moods.mjs`、`tide-mood-rules.mjs`：模拟的情绪状态，有上限、会衰减、每次变化都要有依据。
    - `tide-traits.mjs`：缓慢变化的特质，变化要经主人批准；身份核心默认锁定。
    - `tide-sense.mjs`：把"观察到的、计划的、已完成的"严格分开的状态快照。
  - `desktop-pulse.mjs`：DSH 用户模块，把上面这些挂在同一个仅主人可用的工具后面。
- `policy/`：工具执行策略。
- `docs/INTEGRATION-NOTES.md`：早期的集成笔记（中文）。

## 代码强制的设计规则

- 这些模块不会写入原有的记忆、人设和凭据。
- 模拟的情绪和特质不是"主观意识"的声明，只会影响非关键的措辞，从不拦截安全停止。
- 自主只做到"提议"：主人批准后才执行；所有变化有上限、有依据记录，并且可以回退。

## 运行测试

需要 Node 22 及以上。不依赖宿主的纯逻辑测试可以直接跑：

```
cd integration
TIDEMIND_FIXTURE_STORE=isolated-pinned node --test test-tide-goals.mjs test-tide-life.mjs test-tide-affect-traits.mjs test-tide-moods.mjs test-tide-mood-rules.mjs test-tide-sense.mjs
```

建议一次只跑一个测试文件，同时并行跑很多 SQLite 夹具会比较吃资源。

## 不包含的内容

个人数据、记忆数据库、人设、凭据、第三方宿主源码（请自行安装 DSH / Aurabot）以及私人的自定义模块。代码里写死的本机路径已替换成占位符，例如 `C:/Users/USERNAME`、`<DSH_APP_DIR>`、`<MEMORY_LAYERS_DIR>`。使用安装脚本之前，请先设置 `TIDEMIND_APP_MODULES` 和其他环境变量，指向你自己的位置。

## 改了 release 里的文件后，为什么"重载模块"不生效（重要）

模块入口导入的是 `releases/<hash>/integration/desktop-pulse.mjs`。Node 的 ESM 会按 URL 缓存模块：路径没变，重载模块（甚至重启模块加载器）拿到的仍是第一次的旧代码。

所以**不要原地修改 release 目录里的文件**。正确做法是改源码，再生成新的 release 目录（目录名取文件内容哈希，URL 随之变化）。升级脚本 `--upgrade` 就是这样做的。原地改十次，跑的都是第一次那份。

## 许可证

尚未选择许可证。发布前请先添加。
