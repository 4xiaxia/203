/* @qh-core LANE=B-V2 POINT=TIMING 160cpm phase-local display + global for render */
export const AGENT_B_V2_SPEECH_RATE = 160
export const AGENT_B_V2_ROW_GAP_MS = 1500

function normalizeSpeech(speech) {
  return String(speech || '')
    .trim()
}

function countCharacters(speech) {
  // 语速按纯文字计算，去掉空白和中英文标点
  return [...normalizeSpeech(speech)
    .replace(/\s+/g, '')
    .replace(/[。，、；：？！""''（）《》【】……—.,!?;:'"()[\]<>~`@#$%^&*_+=|\\/]/g, '')  ].length
}

// 中文标点停顿时长：句号700ms / 逗号500ms / 省略号1000ms
function countPunctuationPause(speech) {
  const text = String(speech || '')
  const periodCount = (text.match(/。/g) || []).length
  const commaCount = (text.match(/，/g) || []).length
  const ellipsisCount = (text.match(/…+/g) || []).length
  return periodCount * 700 + commaCount * 500 + ellipsisCount * 1000
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
