
/**
 * Model-facing tools. Definitions use raw JSON Schema and no package imports,
 * because a plugin installed as a local link does not get the profile's
 * hoisted node_modules on every host.
 */
function tool(spec) {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, note: { type: 'string' } },
        additionalProperties: true
      },
      render: (args, value) => [{
        type: 'text',
        text: typeof value === 'string' ? value : JSON.stringify(value, null, 2)
      }]
    },
    execute: spec.execute
  }
}

const obj = (props, required = []) => ({ type: 'object', properties: props, required })

export function buildTools(deps) {
  const { store, config, invalidate } = deps

  return [
    tool({
      name: 'lmem_search',
      description: '检索长期记忆（核心/情景/语义/工作状态）。查询前先检索；默认只返回 active，pending 仅用于审核。返回按相关度排序并去重。',
      parameters: obj({
        query: { type: 'string', description: '检索词，用自然语言即可' },
        layer: { type: 'string', enum: ['core', 'episodic', 'semantic', 'working'], description: '限定图层' },
        limit: { type: 'integer', description: '最多返回条数，默认 8' },
        include_pending: { type: 'boolean', description: '是否包含待审核记忆' }
      }, ['query']),
      execute: async (args) => {
        const layers = args.layer ? [args.layer] : undefined
        const result = store.search(args.query, {
          layers,
          limit: args.limit ?? 8,
          includePending: args.include_pending === true
        })
        return { ok: true, query: result.query, total: result.total, items: result.items }
      }
    }),

    tool({
      name: 'lmem_write',
      description: '写入一条长期记忆。写之前先 lmem_search，避免重复。layer=core 放长期稳定信息（偏好/关系/规则/目标），semantic 放可复用事实，episodic 放带时间的事件，working 放当前任务。同一 key 的新内容会确定性取代旧值；完全重复会自动合并。人格设定用 layer=core, category=persona, key=self。',
      parameters: obj({
        layer: { type: 'string', enum: ['core', 'episodic', 'semantic', 'working'], description: '记忆图层' },
        content: { type: 'string', description: '记忆正文，写清事实本身；不要写入密码、令牌、密钥' },
        category: { type: 'string', description: 'persona/preference/relationship/rule/goal/event/task/fact' },
        key: { type: 'string', description: '稳定槽位名，如 music、current-task、self。同 key 不同内容会取代旧值' },
        tags: { type: 'string', description: '逗号分隔标签' },
        importance: { type: 'integer', description: '1-5，默认 3' },
        confidence: { type: 'number', description: '0-1，默认 1' },
        status: { type: 'string', enum: ['active', 'pending'], description: '不确定时用 pending 待审核' }
      }, ['layer', 'content']),
      execute: async (args, exec) => {
        const result = await store.write({
          ...args,
          source: 'tool',
          source_session: exec?.agent?.session?.id ?? null
        })
        invalidate()
        return { ok: result.action !== 'rejected', ...result }
      }
    }),

    tool({
      name: 'lmem_update',
      description: '修正或更新一条已有记忆。用户纠正事实时改 content；不再有效时把 status 设为 withdrawn；也可以调整重要度和标签。',
      parameters: obj({
        id: { type: 'string', description: '记忆 id' },
        content: { type: 'string', description: '修正后的正文' },
        status: { type: 'string', enum: ['active', 'pending', 'withdrawn'], description: '新状态' },
        tags: { type: 'string', description: '替换标签，逗号分隔' },
        importance: { type: 'integer', description: '1-5' }
      }, ['id']),
      execute: async (args) => {
        const result = await store.update(args.id, args)
        invalidate()
        return { ok: result.action !== 'rejected', ...result }
      }
    }),

    tool({
      name: 'lmem_forget',
      description: '永久删除一条或多条记忆（用户明确要求忘记时使用）。按 id 或按 query 删除，会同时清理全文索引；主表记录被真实删除，只在审计表留下不可还原的哈希。',
      parameters: obj({
        id: { type: 'string', description: '精确记忆 id' },
        query: { type: 'string', description: '按检索词批量删除匹配项' },
        layer: { type: 'string', enum: ['core', 'episodic', 'semantic', 'working'] },
        limit: { type: 'integer', description: '按 query 删除时最多几条，默认 20' },
        persona_key: { type: 'string', description: '删除人格槽位（如 self），与 id/query 二选一' }
      }),
      execute: async (args) => {
        if (args.persona_key) {
          const result = await store.forgetPersona(args.persona_key)
          invalidate()
          return { ok: true, ...result }
        }
        const result = await store.forget(args)
        invalidate()
        return { ok: true, ...result }
      }
    }),

    tool({
      name: 'lmem_review',
      description: '审核自动抓取的待确认记忆。action=list 列出 pending；approve 转正；reject 撤回（保留记录但不再检索）。只在用户明确确认后 approve。',
      parameters: obj({
        action: { type: 'string', enum: ['list', 'approve', 'reject'], description: '操作' },
        id: { type: 'string', description: '待审核记忆 id' },
        limit: { type: 'integer', description: 'list 返回条数，默认 20' }
      }, ['action']),
      execute: async (args) => {
        if (args.action === 'list') {
          return { ok: true, pending: store.list({ status: 'pending', limit: args.limit ?? 20 }) }
        }
        if (!args.id) return { ok: false, note: '需要 id' }
        const result = await store.update(args.id, { status: args.action === 'approve' ? 'active' : 'withdrawn' })
        invalidate()
        return { ok: result.action !== 'rejected', ...result }
      }
    }),

    tool({
      name: 'lmem_admin',
      description: '记忆系统管理：stats 查看统计与检索 token；backup 立即备份；list_backups 列出备份；restore 恢复指定备份（会先自动备份当前数据）；export 导出 Markdown/JSON。',
      parameters: obj({
        action: { type: 'string', enum: ['stats', 'backup', 'list_backups', 'restore', 'export'], description: '操作' },
        path: { type: 'string', description: 'restore 时的备份文件绝对路径' }
      }, ['action']),
      execute: async (args) => {
        if (args.action === 'stats') return store.stats()
        if (args.action === 'backup') return { ok: true, ...store.backup('manual') }
        if (args.action === 'list_backups') return { ok: true, dir: store.backupDir, files: store.listBackups() }
        if (args.action === 'export') return { ok: true, ...store.exportAll() }
        if (args.action === 'restore') {
          const result = store.restore(args.path)
          invalidate()
          return result
        }
        return { ok: false, note: '未知操作' }
      }
    })
  ]
}
