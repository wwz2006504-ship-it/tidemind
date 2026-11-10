// TideMind 3.0 panel: renders the real affect / moods / traits / life values.
// Data comes from the module's api.route('/state') endpoint.
const { useState, useEffect } = React
const pct = (v) => Math.max(0, Math.min(100, Math.round((Number(v) || 0) * 100)))
const num = (v) => (Number(v) || 0).toFixed(2)
const bar = (label, v, color) => h('div', { key: label, style: { display: 'flex', alignItems: 'center', gap: 8, margin: '1px 0' } },
  h('span', { className: 'ab-small', style: { width: 44, flex: 'none' } }, label),
  h('div', { style: { flex: 1, background: 'rgba(127,127,127,.22)', height: 7, borderRadius: 4, overflow: 'hidden' } },
    h('div', { style: { width: pct(v) + '%', height: '100%', background: color } })),
  h('span', { className: 'ab-small', style: { width: 36, textAlign: 'right' } }, num(v)))
const block = (title, rows, note) => h('div', { style: { margin: '10px 0' } },
  h('div', { className: 'ab-small', style: { fontWeight: 600, marginBottom: 4 } }, title),
  rows,
  note ? h('div', { className: 'ab-muted ab-small', style: { marginTop: 4, lineHeight: 1.4 } }, note) : null)

return function Panel({ toast }) {
  const [s, setS] = useState(null)
  const [err, setErr] = useState('')
  const load = async () => {
    try {
      const r = await call('/state')
      if (r && r.ok) { setS(r); setErr('') } else setErr((r && r.message) || '没拿到状态')
    } catch (e) { setErr(String((e && e.message) || e)) }
  }
  useEffect(() => { load(); const t = setInterval(load, 4000); return () => clearInterval(t) }, [])
  if (err) return h(ui.Card, { title: 'TideMind 3.0' }, h('div', { className: 'ab-note' }, err),
    h(ui.Btn, { onClick: load }, '重试'))
  if (!s) return h(ui.Card, { title: 'TideMind 3.0' }, h('div', { className: 'ab-muted' }, '读状态中…'))
  const aff = s.affect || {}, moo = s.moods || {}, tra = s.traits || {}, lif = s.life || {}
  const budget = s.budget || {}
  return h(ui.Card, { title: 'TideMind 3.0' },
    h('div', { className: 'ab-note', style: { marginBottom: 6 } },
      (s.rest ? '休息中' : '运行中') + '｜预算 ' + (budget.spent ?? 0) + '/' + (budget.budget ?? 0) +
      '｜任务 ' + (s.tasks || []).length + ' 条｜目标 ' + (s.goals || []).length + ' 个'),
    block('情绪 affect（短时）', Object.entries(aff.states || {}).map(([k, v]) => bar(k, v, '#5b8def')), aff.note),
    block('心情 moods（七宗罪刻度）', Object.entries(moo.levels || {}).map(([k, v]) => bar(k, v, '#d4747b')), moo.note),
    block('性格 traits（慢变量）', Object.entries(tra.values || {}).map(([k, v]) => bar(k, v, '#5aa87a')),
      (tra.note || '') + (tra.candidates ? '｜待批候选 ' + tra.candidates + ' 个' : '')),
    block('生活 life（提案制）', h('div', { className: 'ab-note' },
      (lif.paused ? '已暂停' : '正常') + '｜待答 ' + (lif.unanswered ?? 0) + '｜提案 ' + (lif.proposals ?? 0) + '｜日志 ' + (lif.log ?? 0)), lif.note),
    (s.goals || []).length ? block('目标', (s.goals || []).map((g) => h('div', { key: g.id, className: 'ab-note' },
      g.state + '｜' + g.steps + '｜' + g.title + (g.reason ? '（' + g.reason + '）' : '')))) : null,
    h('div', { style: { marginTop: 8 } }, h(ui.Btn, { onClick: load }, '刷新'))
  )
}
