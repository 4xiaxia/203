/* @qh-core LANE=B-V2 POINT=TIMING 160cpm phase-local display + global for render */
export const AGENT_B_V2_SPEECH_RATE = 160
export const AGENT_B_V2_ROW_GAP_MS = 1500

function normalizeSpeech(speech) {
  return String(speech || '')
    .trim()
}

export function countCharacters(speech) {
  // 语速按纯文字计算，去掉空白和中英文标点
  return [...normalizeSpeech(speech)
    .replace(/\s+/g, '')
    .replace(/[。，、；：？！""''（）《》【】……—.,!?;:'"()[\]<>~`@#$%^&*_+=|\\/]/g, '')  ].length
}

// 中文标点停顿时长：句号700ms / 逗号500ms / 省略号1000ms
export function countPunctuationPause(speech) {
  const text = String(speech || '')
  const periodCount = (text.match(/。/g) || []).length
  const commaCount = (text.match(/，/g) || []).length
  const ellipsisCount = (text.match(/…+/g) || []).length
  return periodCount * 700 + commaCount * 500 + ellipsisCount * 1000
}

/**
 * 根据口播文本中的关键词/文本锚点，动态计算该位置的起始时间戳（秒）
 * @param {string} speech 口播完整文案
 * @param {string} triggerWord 触发词/文本锚点
 * @param {object} options 配置（speechSpeed, fineTune 等）
 */
export function calculateSpeechAnchorTimestamp(speech, triggerWord, options = {}) {
  const speed = Number.isFinite(options.speechSpeed) && options.speechSpeed > 0
    ? options.speechSpeed
    : AGENT_B_V2_SPEECH_RATE
  const fineTune = typeof options.fineTune === 'number' ? options.fineTune : 0

  const s = String(speech || '').trim()
  const kw = String(triggerWord || '').trim()

  if (!s || !kw) {
    return {
      matched: false,
      charIndex: -1,
      endIndex: -1,
      matchText: '',
      prefixChars: 0,
      totalChars: countCharacters(s),
      pauseSeconds: 0,
      calculatedOffset: 0.2,
      finalOffset: 0.2,
      confidence: 0,
      occurrences: 0,
    }
  }

  const lowerS = s.toLowerCase()
  const lowerKw = kw.toLowerCase()
  let idx = lowerS.indexOf(lowerKw)

  // 兜底模糊匹配：去除标点符号后再试一次
  if (idx === -1) {
    const cleanKw = kw.replace(/[\s。，、；：？！""''（）《》【】……—.,!?;:'"()[\]<>~`@#$%^&*_+=|\\/]/g, '')
    if (cleanKw.length >= 2) {
      idx = lowerS.indexOf(cleanKw.toLowerCase())
    }
  }

  const totalChars = countCharacters(s)

  if (idx === -1) {
    return {
      matched: false,
      charIndex: -1,
      endIndex: -1,
      matchText: kw,
      prefixChars: 0,
      totalChars,
      pauseSeconds: 0,
      calculatedOffset: 0.2,
      finalOffset: 0.2,
      confidence: 0,
      occurrences: 0,
    }
  }

  // 统计在文中的出现频次
  let count = 0
  let searchPos = 0
  while (searchPos < lowerS.length) {
    const nextIdx = lowerS.indexOf(lowerKw, searchPos)
    if (nextIdx === -1) break
    count++
    searchPos = nextIdx + Math.max(1, lowerKw.length)
  }

  const prefixText = s.slice(0, idx)
  const prefixChars = countCharacters(prefixText)
  const pauseMs = countPunctuationPause(prefixText)
  const speechTimeMs = (prefixChars * 60000) / speed
  const totalMs = speechTimeMs + pauseMs

  const rawOffset = Math.max(0.1, totalMs / 1000)
  const calculatedOffset = Math.round(rawOffset * 10) / 10
  const finalOffset = Math.max(0, Math.round((calculatedOffset + fineTune) * 10) / 10)

  return {
    matched: true,
    charIndex: idx,
    endIndex: idx + kw.length,
    matchText: s.slice(idx, idx + kw.length),
    prefixChars,
    totalChars,
    progressPct: totalChars > 0 ? Math.round((prefixChars / totalChars) * 100) : 0,
    pauseSeconds: Math.round(pauseMs / 100) / 10,
    calculatedOffset,
    finalOffset,
    confidence: count === 1 ? 1.0 : 0.85,
    occurrences: count,
  }
}

/**
 * 自动提取口播文案中的高质量候选文本锚点（供一键选择）
 * @param {string} speech 口播完整文案
 * @param {string} boardText 可选板书文案（交叉分析更精准）
 */
export function extractAnchorCandidates(speech, boardText = '') {
  const text = String(speech || '').trim()
  if (!text) return []

  const candidates = new Set()

  // 1. 引号强调词
  const quotes = text.matchAll(/[“"']([^“”"'\n]{2,12})[”"']/g)
  for (const m of quotes) {
    if (m[1]?.trim()) candidates.add(m[1].trim())
  }

  // 2. 数学算式与带单位数词 (如 12-5=7, 12吨, 5元, 2倍)
  const mathMatches = text.matchAll(/(?:\d+(?:\.\d+)?(?:\s*[-+×÷=*/><]\s*\d+(?:\.\d+)?)+|\d+(?:\.\d+)?\s*(?:吨|元|米|厘米|个|只|本|棵|次|倍|度|分|秒|时|步))/g)
  for (const m of mathMatches) {
    if (m[0]?.trim()) candidates.add(m[0].trim())
  }

  // 3. 板书与口播重合的高价值词汇
  if (boardText) {
    const cleanBoard = String(boardText)
      .replace(/[\$\\]/g, '')
      .split(/[\s\n=+\-×÷]+/)
      .filter((w) => w.length >= 2 && w.length <= 8)
    for (const word of cleanBoard) {
      if (text.includes(word)) candidates.add(word)
    }
  }

  // 4. 自然短语分句片段 (2~8字)
  const clauses = text.split(/[，。、；：？！\n]+/)
  for (const c of clauses) {
    const trimmed = c.trim()
    if (trimmed.length >= 2 && trimmed.length <= 8) {
      candidates.add(trimmed)
    } else if (trimmed.length > 8) {
      // 取短语前段
      candidates.add(trimmed.slice(0, 6))
    }
  }

  return [...candidates].slice(0, 10)
}

export function applyAgentBV2Timeline(rows, options = {}) {
  const rowGapMs = Number.isFinite(options.rowGapMs) && options.rowGapMs > 0
    ? options.rowGapMs
    : AGENT_B_V2_ROW_GAP_MS
  let globalCursorMs = 0   // 全局累计，供渲染管线使用

  return rows.map((row) => {
    const speech = normalizeSpeech(row.speech)
    const speechCharacters = countCharacters(speech)
    const punctuationPauseMs = countPunctuationPause(speech)
    // 空行（speech为空）视为1500ms；非空行 = 口播时长 + 标点停顿
    const estimatedDurationMs = speechCharacters > 0
      ? Math.max(1000, Math.round(speechCharacters * 60000 / AGENT_B_V2_SPEECH_RATE) + punctuationPauseMs)
      : rowGapMs

    const estimatedStartMs = globalCursorMs
    const estimatedEndMs = estimatedStartMs + estimatedDurationMs
    globalCursorMs = estimatedEndMs + rowGapMs

    return {
      ...row,
      speech,
      timingStatus: 'estimated',
      timingSource: 'agent-b-v2-160-cpm',
      speechCharacters,
      estimatedDurationMs,
      estimatedStartMs,    // 全局绝对起点（渲染用，不导出）
      estimatedEndMs,      // 全局绝对终点（渲染用，不导出）
    }
  })
}
