/* ASR 口播稿优化与板书规范化引擎
   严格遵循规范：
   1. 口播稿为纯文字，可直接导入 TTS 自然朗读；绝不包含任何控制标签或占位符
   2. 阿拉伯数字保留阿拉伯数字，不改写为中文数字（如 15分之7 不写成 十五分之七）
   3. 小数：整数部分保留阿拉伯数字，小数点读"点"，小数部分逐位读汉字（如 3.14 -> 3点一四，0.05 -> 0点零五）
   4. 分数：先读分母再读分子，保留阿拉伯数字（\frac{7}{15} -> 15分之7，1\frac{1}{2} -> 1又2分之1）
   5. 根号/幂次：√9 -> 根号9，a² -> a的平方，a³ -> a的立方，a^4 -> a的4次方
   6. 运算符：+ 读作"加"，- 读作"减"，×/x 读作"乘以"，÷ 读作"除以"，= 读作"等于"
   7. 区分未知数 x（读作"艾克斯"）与乘法 x（读作"乘以"）
   8. 括号必须读出"括号里"
   9. 板书：乘法统一使用小写字母 x，禁止乘号 ×；除法可用 ÷；分数统一使用 \frac{分子}{分母}
*/

import { formatMathSpeechToChinese } from '../lib/mathAsrConverter.js'

/**
 * 优化单行 speech 口播稿文本（结合数学算式口播转换库）
 */
export function polishSpeechText(rawSpeech) {
  if (!rawSpeech || typeof rawSpeech !== 'string') return ''
  return formatMathSpeechToChinese(rawSpeech)
}

/**
 * 规范化板书 board 文本
 * - 乘法统一使用小写字母 x，禁止乘号 ×
 * - 除法可以用 ÷
 * - 分数使用 KaTeX 上下结构 \frac{分子}{分母}
 */
export function normalizeBoardContent(content) {
  if (!content || typeof content !== 'string') return ''

  let text = content

  // 1. 乘号替换为小写字母 x
  text = text.replace(/×|✕|\\times/g, 'x')
  text = text.replace(/\\cdot/g, 'x')

  // 2. 斜杠分数转为 KaTeX 上下结构 \frac{a}{b}
  text = text.replace(/(?<!\d\/)(?<!\\frac\{)(\b\d+)\/(\d+\b)/g, '\\frac{$1}{$2}')

  return text
}

/**
 * 对整套 rows 进行完整的 ASR 与板书规范化处理
 * 返回 { rows, changes }
 */
export function polishRowsASR(originalRows) {
  if (!Array.isArray(originalRows)) return { rows: [], changes: [] }

  const changes = []
  const polishedRows = originalRows.map((origRow, index) => {
    const rowNum = index + 1
    const stage = origRow?.stage || ''
    const origSpeech = String(origRow?.speech || '')
    const polishedSpeech = polishSpeechText(origSpeech)

    if (origSpeech !== polishedSpeech) {
      changes.push({
        row: rowNum,
        field: 'speech',
        before: origSpeech,
        after: polishedSpeech,
        reason: 'ASR 口播纯文字优化：转换数学符号为自然中文读法、规范小数与分数读音',
      })
    }

    let origBoardObj = origRow?.board
    let newBoard = origBoardObj

    if (typeof origBoardObj === 'string') {
      const normalizedStr = normalizeBoardContent(origBoardObj)
      if (normalizedStr !== origBoardObj) {
        changes.push({
          row: rowNum,
          field: 'board',
          before: origBoardObj,
          after: normalizedStr,
          reason: '板书符号规范化：乘法统一为小写 x，规范分数与公式',
        })
      }
      newBoard = normalizedStr
    } else if (origBoardObj && typeof origBoardObj === 'object') {
      const origContent = String(origBoardObj.content || '')
      const normalizedContent = normalizeBoardContent(origContent)
      if (origContent !== normalizedContent) {
        changes.push({
          row: rowNum,
          field: 'board',
          before: origContent,
          after: normalizedContent,
          reason: '板书符号规范化：乘法统一为小写 x，规范分数与公式',
        })
      }
      newBoard = {
        ...origBoardObj,
        content: normalizedContent,
      }
    }

    return {
      stage,
      speech: polishedSpeech,
      board: newBoard,
      actionSpec: Array.isArray(origRow?.actionSpec) ? origRow.actionSpec : [],
    }
  })

  return {
    rows: polishedRows,
    changes,
  }
}
