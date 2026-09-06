/* @qh-core LANE=B-V2 POINT=CONTRACT_NORMALIZE model rows into board-readable fields */
import { validateBoardToolAction } from '../board-tools/boardToolCatalog.js'
import { calculateSpeechAnchorTimestamp } from './timing.js'
export const AGENT_B_V2_COLUMNS = Object.freeze([
  'stage',
  'speech',
  'board',
  'actionSpec',
])

export const AGENT_B_V2_STAGES = Object.freeze(['题目', '分析', '解答', '总结'])

// 环节别名容错表（温和吸附，防止大模型在长篇生成中因同义词导致整表抛弃）
const STAGE_SYNONYMS = Object.freeze({
  '思路': '分析',
  '讲解': '分析',
  '过程': '解答',
  '步骤': '解答',
  '计算': '解答',
  '答案': '解答',
  '题面': '题目',
  '题干': '题目',
  '小结': '总结',
  '回顾': '总结',
})

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeStage(stage, index) {
  const clean = String(stage || '').trim()
  if (AGENT_B_V2_STAGES.includes(clean)) return clean
  if (STAGE_SYNONYMS[clean]) return STAGE_SYNONYMS[clean]

  const fallback = index === 0 ? '题目' : '分析'
  console.warn(`[AgentB contract] 非法 stage 值：${JSON.stringify(stage)}（第${index + 1}行），已温和校正为"${fallback}"。合法值仅限：题目/分析/解答/总结`)
  return fallback
}

// board 双兼容：v1.0 字符串 / v2.0 对象 {startCoord, content, startDelay, triggerWord}
// 统一归一化为 v2.0 对象格式输出
export function normalizeBoard(board) {
  if (isRecord(board)) {
    const rawOffset = board.syncOffset ?? board.startDelay
    const offsetNum = typeof rawOffset === 'number' ? rawOffset : (rawOffset ? parseFloat(rawOffset) : undefined)
    const trigger = typeof board.triggerWord === 'string' ? board.triggerWord.trim() : ''
    return {
      startCoord: typeof board.startCoord === 'string' ? board.startCoord : '',
      content: typeof board.content === 'string' ? board.content : '',
      ...(offsetNum !== undefined && !isNaN(offsetNum) ? {
        syncOffset: Math.max(0, Math.round(offsetNum * 10) / 10),
        startDelay: Math.max(0, Math.round(offsetNum * 10) / 10),
      } : {}),
      ...(trigger ? { triggerWord: trigger } : {}),
    }
  }
  if (typeof board === 'string') {
    return { startCoord: '', content: board }
  }
  return { startCoord: '', content: '' }
}

function tryParseCandidate(str) {
  try {
    return JSON.parse(str)
  } catch {
    // 尝试修补常见的字符串内未转义换行与尾部残缺
    try {
      let patched = str.trim()
      if (patched.startsWith('{') && !patched.endsWith('}')) {
        if (patched.lastIndexOf(']') < patched.lastIndexOf('[')) {
          patched += ']}'
        } else {
          patched += '}'
        }
      }
      return JSON.parse(patched)
    } catch {
      return null
    }
  }
}

function parseJsonObject(text) {
  const source = String(text || '').trim()
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim()
  const candidate = fenced || source
  
  let res = tryParseCandidate(candidate)
  if (res && isRecord(res)) return res

  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start >= 0 && end > start) {
    res = tryParseCandidate(candidate.slice(start, end + 1))
    if (res && isRecord(res)) return res
  }

  // 尝试在最深层的 { "rows" 块处截取
  const rowsIdx = candidate.indexOf('"rows"')
  if (rowsIdx > 0) {
    const subStart = candidate.lastIndexOf('{', rowsIdx)
    if (subStart >= 0) {
      res = tryParseCandidate(candidate.slice(subStart))
      if (res && isRecord(res)) return res
    }
  }

  return null
}

export function normalizeAgentBV2ActionSpec(actionSpec) {
  return (Array.isArray(actionSpec) ? actionSpec : []).flatMap((entry) => {
    if (!isRecord(entry)) return []
    if (entry.capabilityGap) return [{ ...entry }]

    const action = validateBoardToolAction(entry.action)
    if (!action.ok) return []

    // 提取并保留起手时间与触发关键词
    const rawDelay = entry.action?.startDelay ?? entry.action?.syncOffset ?? entry.startDelay ?? entry.syncOffset
    const startDelay = typeof rawDelay === 'number' ? Math.max(0, Math.round(rawDelay * 10) / 10) : (rawDelay ? parseFloat(rawDelay) : undefined)
    const rawTrigger = entry.action?.triggerWord ?? entry.triggerWord
    const triggerWord = typeof rawTrigger === 'string' && rawTrigger.trim() ? rawTrigger.trim() : undefined

    const timingExtra = {
      ...(startDelay !== undefined && !isNaN(startDelay) ? { startDelay, syncOffset: startDelay } : {}),
      ...(triggerWord ? { triggerWord } : {}),
    }

    return [{
      ...entry,
      ...timingExtra,
      action: {
        ...action.value,
        ...timingExtra,
      },
    }]
  })
}

// 解析并防粘连板书起手坐标
function parseCoord(coordStr) {
  if (!coordStr || typeof coordStr !== 'string') return null
  const m = coordStr.match(/[\[\(]?\s*([\d.]+)\s*(%?)\s*,\s*([\d.]+)\s*(%?)\s*[\]\)]?/)
  if (!m) return null
  const isPercent = m[2] === '%' || m[4] === '%' || (parseFloat(m[1]) <= 100 && parseFloat(m[3]) <= 100)
  return {
    x: parseFloat(m[1]),
    y: parseFloat(m[3]),
    isPercent,
  }
}

export function normalizeAgentBV2BoardCells(rows) {
  const lastStateByStage = {}

  return (Array.isArray(rows) ? rows : []).flatMap((row, index) => {
    if (!isRecord(row)) return []
    const board = normalizeBoard(row.board)
    const stage = normalizeStage(row.stage, index)
    const speech = typeof row.speech === 'string' ? row.speech : ''

    // 行级与板书级起手时间、触发词双向协同
    let rawOffset = row.syncOffset ?? row.startDelay ?? board.syncOffset ?? board.startDelay
    const triggerWord = typeof row.triggerWord === 'string' && row.triggerWord.trim()
      ? row.triggerWord.trim()
      : (typeof board.triggerWord === 'string' && board.triggerWord.trim() ? board.triggerWord.trim() : undefined)

    // 若有触发词且未定秒数，根据在口播中的文本识别位置动态精准推算起始时间戳
    if ((rawOffset === undefined || isNaN(rawOffset)) && triggerWord && speech) {
      const timingCalc = calculateSpeechAnchorTimestamp(speech, triggerWord)
      if (timingCalc.matched) {
        rawOffset = timingCalc.finalOffset
      } else {
        rawOffset = 0.2
      }
    }

    const syncOffset = typeof rawOffset === 'number'
      ? Math.max(0, Math.round(rawOffset * 10) / 10)
      : (rawOffset ? parseFloat(rawOffset) : undefined)

    if (syncOffset !== undefined && !isNaN(syncOffset)) {
      board.syncOffset = syncOffset
      board.startDelay = syncOffset
    }
    if (triggerWord) {
      board.triggerWord = triggerWord
    }

    // 【起手坐标防粘连智能间距保护】
    // 检查同一环节内连续两个有板书内容的小步骤是否坐标粘连
    if (board.content && board.startCoord) {
      const parsed = parseCoord(board.startCoord)
      if (parsed) {
        const last = lastStateByStage[stage]
        if (last && last.y !== undefined) {
          const prevLines = last.lines || 1
          if (parsed.isPercent) {
            const minGap = prevLines * 7 + 4 // 每行约7%高 + 4%呼吸留白
            if (parsed.y <= last.y + 3 || parsed.y < last.y + minGap) {
              const spacedY = Math.min(92, Math.round((last.y + minGap) * 10) / 10)
              board.startCoord = `[${parsed.x}%, ${spacedY}%]`
              parsed.y = spacedY
            }
          } else {
            const minGapPx = prevLines * 36 + 24
            if (parsed.y <= last.y + 10 || parsed.y < last.y + minGapPx) {
              const spacedY = Math.round(last.y + minGapPx)
              board.startCoord = `[${parsed.x}, ${spacedY}]`
              parsed.y = spacedY
            }
          }
        }
        const currentLines = Math.max(1, board.content.split('\n').length)
        lastStateByStage[stage] = { x: parsed.x, y: parsed.y, lines: currentLines }
      }
    }

    // 动作内起手延时与触发词根据口播协同补全
    const rawActionSpec = normalizeAgentBV2ActionSpec(row.actionSpec).map(entry => {
      if (entry.action && entry.action.triggerWord && entry.action.startDelay === undefined && speech) {
        const actPos = speech.indexOf(entry.action.triggerWord)
        if (actPos >= 0) {
          const actOffset = Math.max(0.2, Math.round((actPos / 2.67) * 10) / 10)
          entry.action.startDelay = actOffset
          entry.action.syncOffset = actOffset
          entry.startDelay = actOffset
          entry.syncOffset = actOffset
        }
      }
      return entry
    })

    return [{
      stage,
      speech,
      board,
      ...(syncOffset !== undefined && !isNaN(syncOffset) ? { syncOffset, startDelay: syncOffset } : {}),
      ...(triggerWord ? { triggerWord } : {}),
      actionSpec: rawActionSpec,
    }]
  })
}

export function validateAgentBV2Rows(rows, _options = {}) {
  const normalizedRows = normalizeAgentBV2BoardCells(rows)
  if (!normalizedRows.length) {
    return { ok: false, error: 'Agent B 必须返回至少一行五字段数据' }
  }
  return { ok: true, value: normalizedRows }
}

export function parseAgentBV2Response(text, _options = {}) {
  const parsed = parseJsonObject(text)
  if (!isRecord(parsed)) return { ok: false, error: 'Agent B 返回内容不是 JSON 对象' }
  if (!Array.isArray(parsed.rows)) return { ok: false, error: 'Agent B 返回内容没有可用的 rows 数组' }

  // 归一化前先检查原始 stage：先清除首尾空格；在兜底模式（allowSynonyms）下允许温和吸附
  const allowSynonyms = Boolean(_options?.allowSynonyms)
  const invalidStageRows = parsed.rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => {
      const clean = String(row?.stage || '').trim()
      if (AGENT_B_V2_STAGES.includes(clean)) return false
      if (allowSynonyms && STAGE_SYNONYMS[clean]) return false
      return true
    })
  if (invalidStageRows.length > 0) {
    const details = invalidStageRows
      .map(({ row, index }) => `第${index + 1}行 stage=${JSON.stringify(row?.stage)}`)
      .join('；')
    return {
      ok: false,
      code: 'INVALID_STAGE',
      error: `非法 stage 值（${details}）。stage 仅限四种："题目""分析""解答""总结"。禁止使用"思路""讲解""过程""步骤""方法""计算""答案"等同义词，请重新输出完整五字段表。`,
    }
  }

  return validateAgentBV2Rows(parsed.rows, _options)
}
