<template>
  <div class="keyword-trigger-config" :class="{ 'is-inline': inline }">
    <!-- 头部标题栏 -->
    <div class="config-header" v-if="!hideHeader">
      <div class="header-left">
        <span class="header-icon">🎯</span>
        <span class="header-title">关键词触发与动态起步</span>
        <span class="header-step-tag" v-if="stepIndex !== undefined">步骤 #{{ stepIndex + 1 }}</span>
      </div>
      <div class="header-status">
        <span v-if="timingResult.matched" class="status-badge matched">
          <span class="status-dot"></span>
          已锁定「{{ timingResult.matchText }}」 @ +{{ timingResult.finalOffset.toFixed(1) }}s
        </span>
        <span v-else-if="localTriggerWord" class="status-badge not-found">
          <span class="status-dot warning"></span>
          口播中未匹配「{{ localTriggerWord }}」
        </span>
        <span v-else class="status-badge unbound">
          未绑定锚点 (默认+{{ (syncOffset || 0.2).toFixed(1) }}s)
        </span>
      </div>
    </div>

    <!-- 交互式口播文本锚点定位区 -->
    <div class="speech-anchor-section">
      <div class="section-sub-header">
        <span class="sub-title">🎙️ 口播稿文字流 (点击任意词或划选文本，即刻设为起笔锚点)</span>
        <span class="char-count-pill">{{ speechCharsCount }} 字</span>
      </div>

      <div
        ref="speechViewerRef"
        class="speech-interactive-canvas"
        @mouseup="handleTextSelection"
      >
        <template v-if="speechSegments.length">
          <span
            v-for="(seg, i) in speechSegments"
            :key="`seg-${i}`"
            :class="[
              'speech-word-node',
              seg.isAnchor ? 'is-anchor-node' : '',
              seg.isPast ? 'is-pre-anchor' : 'is-post-anchor',
            ]"
            :title="seg.isAnchor ? `当前锚点词 (起步于第 ${timingResult.charIndex + 1} 字)` : `点击将「${seg.text}」设为触发词`"
            @click="selectWordAsAnchor(seg.text)"
          >
            <span v-if="seg.isAnchor" class="anchor-pin-flag">📌</span>
            <span class="node-text">{{ seg.text }}</span>
          </span>
        </template>
        <div v-else class="speech-empty-tip">
          口播稿暂无文字，请先在口播列输入台词
        </div>
      </div>

      <!-- 划选文字浮动快捷提示 -->
      <div v-if="selectedSelectionText" class="selection-floating-bar">
        <span class="selection-tip">已划选文本: <strong>「{{ selectedSelectionText }}」</strong></span>
        <button class="btn-bind-selection" @click="applySelectedTextAsAnchor">
          📌 设为起笔锚点
        </button>
      </div>
    </div>

    <!-- 智能候选推荐词与手动检索 -->
    <div class="candidate-keyword-bar">
      <div class="candidate-label">💡 智能候选锚点:</div>
      <div class="candidate-chips">
        <button
          v-for="cand in candidateAnchors"
          :key="cand"
          :class="['cand-chip', localTriggerWord === cand ? 'is-active' : '']"
          @click="selectWordAsAnchor(cand)"
        >
          {{ cand }}
        </button>
        <span v-if="!candidateAnchors.length" class="no-cand-text">（口播较短，暂无推荐，可直接在上方点击字词）</span>
      </div>
    </div>

    <!-- 搜索/输入与微调控制 -->
    <div class="trigger-input-row">
      <div class="input-col">
        <label class="input-label">指定触发词 / 文本锚点:</label>
        <div class="trigger-input-wrap">
          <input
            type="text"
            v-model="localTriggerWord"
            placeholder="在口播中念到此词时落笔..."
            class="anchor-text-input"
            @input="onInputTriggerWord"
          />
          <button v-if="localTriggerWord" class="btn-clear-input" title="清除触发词" @click="clearTriggerWord">
            ✕
          </button>
        </div>
      </div>

      <div class="adjust-col">
        <label class="input-label">
          起笔微调提前/延后 (秒):
          <span class="offset-val" :class="{ 'has-tune': fineTuneDelta !== 0 }">
            {{ fineTuneDelta > 0 ? `+${fineTuneDelta.toFixed(1)}s` : (fineTuneDelta < 0 ? `${fineTuneDelta.toFixed(1)}s` : '同步') }}
          </span>
        </label>
        <div class="fine-tune-steppers">
          <button class="step-chip" :class="{ active: fineTuneDelta === -0.3 }" @click="setFineTune(-0.3)">-0.3s提前</button>
          <button class="step-chip" :class="{ active: fineTuneDelta === -0.1 }" @click="setFineTune(-0.1)">-0.1s</button>
          <button class="step-chip" :class="{ active: fineTuneDelta === 0 }" @click="setFineTune(0)">同步</button>
          <button class="step-chip" :class="{ active: fineTuneDelta === 0.2 }" @click="setFineTune(0.2)">+0.2s</button>
          <button class="step-chip" :class="{ active: fineTuneDelta === 0.5 }" @click="setFineTune(0.5)">+0.5s延后</button>
        </div>
      </div>
    </div>

    <!-- 动态时间戳计算明细卡片 -->
    <div class="dynamic-timing-card" v-if="timingResult.matched">
      <div class="timing-card-title">
        <span class="card-icon">⚡</span>
        <span>基于口播识别位置动态演算起手时序 (Dynamic Timing)</span>
      </div>
      <div class="timing-metrics-grid">
        <div class="metric-item">
          <span class="metric-label">文本定位</span>
          <span class="metric-value">第 {{ timingResult.charIndex + 1 }} 字</span>
          <span class="metric-sub">进度约 {{ timingResult.progressPct }}%</span>
        </div>
        <div class="metric-item">
          <span class="metric-label">前序文字朗读</span>
          <span class="metric-value">{{ ((timingResult.prefixChars * 60) / speedRate).toFixed(1) }}s</span>
          <span class="metric-sub">{{ timingResult.prefixChars }} 字 @ {{ speedRate }}字/分</span>
        </div>
        <div class="metric-item">
          <span class="metric-label">前序标点停顿</span>
          <span class="metric-value">+{{ timingResult.pauseSeconds.toFixed(1) }}s</span>
          <span class="metric-sub">自然呼吸间隔</span>
        </div>
        <div class="metric-item highlight">
          <span class="metric-label">动态落笔起点</span>
          <span class="metric-value primary">+{{ timingResult.finalOffset.toFixed(1) }}s</span>
          <span class="metric-sub" v-if="stepStartTime !== undefined">
            总轨时刻: {{ formatSeconds(stepStartTime + timingResult.finalOffset) }}
          </span>
          <span class="metric-sub" v-else>音频开始后秒数</span>
        </div>
      </div>
    </div>

    <div class="unmatched-warning-card" v-else-if="localTriggerWord">
      <span class="warn-icon">⚠️</span>
      <span class="warn-text">在当前口播文案中未找到「<strong>{{ localTriggerWord }}</strong>」，落笔将按默认延时 {{ localOffset.toFixed(1) }}s 执行。请检查是否有错别字，或在上方口播稿中直接点击选择。</span>
    </div>

    <!-- 底部操作栏 -->
    <div class="config-footer" v-if="!hideFooter">
      <button v-if="localTriggerWord" class="btn-unlink" @click="clearTriggerWord">
        ✕ 清除触发锚点 (恢复默认)
      </button>
      <div class="footer-right">
        <span class="footer-summary" v-if="timingResult.matched">
          起笔于「<strong>{{ timingResult.matchText }}</strong>」· 延时 <strong>+{{ timingResult.finalOffset.toFixed(1) }}s</strong>
        </span>
        <button class="btn-confirm-apply" @click="confirmAndApply">
          ✓ 应用配置
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import {
  countCharacters,
  calculateSpeechAnchorTimestamp,
  extractAnchorCandidates,
  AGENT_B_V2_SPEECH_RATE,
} from '../agent-b-v2/timing.js'

const props = defineProps({
  speech: {
    type: String,
    default: '',
  },
  triggerWord: {
    type: String,
    default: '',
  },
  syncOffset: {
    type: Number,
    default: 0.2,
  },
  boardContent: {
    type: [String, Object],
    default: '',
  },
  speechSpeed: {
    type: Number,
    default: AGENT_B_V2_SPEECH_RATE,
  },
  stepIndex: {
    type: Number,
    default: undefined,
  },
  stepStartTime: {
    type: Number,
    default: undefined,
  },
  inline: {
    type: Boolean,
    default: false,
  },
  hideHeader: {
    type: Boolean,
    default: false,
  },
  hideFooter: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits([
  'update:triggerWord',
  'update:syncOffset',
  'update:startDelay',
  'change',
])

const localTriggerWord = ref(props.triggerWord || '')
const localOffset = ref(typeof props.syncOffset === 'number' ? props.syncOffset : 0.2)
const fineTuneDelta = ref(0)
const selectedSelectionText = ref('')
const speechViewerRef = ref(null)

const speedRate = computed(() => props.speechSpeed || AGENT_B_V2_SPEECH_RATE)

// 口播总字数
const speechCharsCount = computed(() => countCharacters(props.speech))

// 板书纯文本（用于交叉抽取候选词）
const boardPureText = computed(() => {
  if (typeof props.boardContent === 'object' && props.boardContent) {
    return props.boardContent.content || props.boardContent.text || ''
  }
  return String(props.boardContent || '')
})

// 智能候选词列表
const candidateAnchors = computed(() => {
  return extractAnchorCandidates(props.speech, boardPureText.value)
})

// 动态时间戳计算
const timingResult = computed(() => {
  return calculateSpeechAnchorTimestamp(props.speech, localTriggerWord.value, {
    speechSpeed: speedRate.value,
    fineTune: fineTuneDelta.value,
  })
})

// 监听 props 变化
watch(
  () => props.triggerWord,
  (val) => {
    localTriggerWord.value = val || ''
  }
)

watch(
  () => props.syncOffset,
  (val) => {
    if (typeof val === 'number') {
      localOffset.value = val
    }
  }
)

// 将口播拆解为可视化词元片段（高亮显示锚点及前序/后序）
const speechSegments = computed(() => {
  const text = String(props.speech || '').trim()
  if (!text) return []

  const kw = localTriggerWord.value.trim()
  if (!kw || !timingResult.value.matched) {
    // 按标点或词切分以供点击
    return tokenizeSpeech(text).map((token) => ({
      text: token,
      isAnchor: false,
      isPast: false,
    }))
  }

  const idx = timingResult.value.charIndex
  const endIdx = timingResult.value.endIndex

  const preText = text.slice(0, idx)
  const anchorText = text.slice(idx, endIdx)
  const postText = text.slice(endIdx)

  const segments = []
  if (preText) {
    tokenizeSpeech(preText).forEach((token) => {
      segments.push({ text: token, isAnchor: false, isPast: true })
    })
  }
  segments.push({
    text: anchorText,
    isAnchor: true,
    isPast: false,
  })
  if (postText) {
    tokenizeSpeech(postText).forEach((token) => {
      segments.push({ text: token, isAnchor: false, isPast: false })
    })
  }
  return segments
})

function tokenizeSpeech(str) {
  // 切分词元，保留短标点分句
  const tokens = []
  const regex = /([，。、；：？！\n]+|[“"'][^“”"'\n]+[”"']|\d+(?:\.\d+)?(?:\s*[-+×÷=*/><]\s*\d+(?:\.\d+)?)*|[a-zA-Z\u4e00-\u9fa5]{1,4})/g
  let match
  let lastIndex = 0
  while ((match = regex.exec(str)) !== null) {
    if (match.index > lastIndex) {
      const skipped = str.slice(lastIndex, match.index)
      if (skipped.trim()) tokens.push(skipped)
    }
    tokens.push(match[0])
    lastIndex = regex.lastIndex
  }
  if (lastIndex < str.length) {
    const rest = str.slice(lastIndex)
    if (rest.trim()) tokens.push(rest)
  }
  return tokens.filter((t) => t && t !== '\n')
}

// 格式化时间
function formatSeconds(sec) {
  const s = Math.max(0, sec || 0)
  const m = Math.floor(s / 60)
  const rem = (s % 60).toFixed(1)
  return `${m > 0 ? `${m}分` : ''}${rem}秒`
}

// 点击某个词作为锚点
function selectWordAsAnchor(word) {
  if (!word) return
  const clean = word.replace(/[，。、；：？！\n]/g, '').trim()
  if (!clean) return
  localTriggerWord.value = clean
  selectedSelectionText.value = ''
  emitChanges()
}

// 划选文本事件监听
function handleTextSelection() {
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed) {
    selectedSelectionText.value = ''
    return
  }
  const text = sel.toString().trim().replace(/[，。、；：？！\n]/g, '')
  if (text && text.length >= 1 && text.length <= 25) {
    selectedSelectionText.value = text
  } else {
    selectedSelectionText.value = ''
  }
}

function applySelectedTextAsAnchor() {
  if (!selectedSelectionText.value) return
  selectWordAsAnchor(selectedSelectionText.value)
  selectedSelectionText.value = ''
}

function onInputTriggerWord() {
  emitChanges()
}

function clearTriggerWord() {
  localTriggerWord.value = ''
  fineTuneDelta.value = 0
  selectedSelectionText.value = ''
  localOffset.value = 0.2
  emitChanges()
}

function setFineTune(delta) {
  fineTuneDelta.value = delta
  emitChanges()
}

function emitChanges() {
  const offset = timingResult.value.matched
    ? timingResult.value.finalOffset
    : localOffset.value

  localOffset.value = offset

  emit('update:triggerWord', localTriggerWord.value)
  emit('update:syncOffset', offset)
  emit('update:startDelay', offset)
  emit('change', {
    triggerWord: localTriggerWord.value,
    syncOffset: offset,
    startDelay: offset,
    timingResult: timingResult.value,
  })
}

function confirmAndApply() {
  emitChanges()
}
</script>

<style scoped>
.keyword-trigger-config {
  display: flex;
  flex-direction: column;
  gap: 12px;
  background: #ffffff;
  border-radius: 12px;
  color: #1e293b;
  font-size: 13px;
  text-align: left;
}

.keyword-trigger-config.is-inline {
  background: transparent;
  padding: 0;
}

/* 头部 */
.config-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 8px;
  border-bottom: 1px solid #f1f5f9;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 6px;
}

.header-icon {
  font-size: 16px;
}

.header-title {
  font-size: 14px;
  font-weight: 700;
  color: #0f172a;
}

.header-step-tag {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  background: #e0e7ff;
  color: #3730a3;
  font-weight: 600;
}

.header-status {
  display: flex;
  align-items: center;
}

.status-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 6px;
}

.status-badge.matched {
  background: #dcfce7;
  color: #15803d;
  border: 1px solid #86efac;
}

.status-badge.not-found {
  background: #fef3c7;
  color: #b45309;
  border: 1px solid #fde68a;
}

.status-badge.unbound {
  background: #f1f5f9;
  color: #64748b;
  border: 1px solid #e2e8f0;
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #22c55e;
}

.status-dot.warning {
  background: #f59e0b;
}

/* 口播文本互动区 */
.speech-anchor-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.section-sub-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.sub-title {
  font-size: 12px;
  font-weight: 600;
  color: #475569;
}

.char-count-pill {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  color: #64748b;
}

.speech-interactive-canvas {
  position: relative;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 10px 12px;
  line-height: 1.8;
  font-size: 13px;
  color: #334155;
  user-select: text;
  max-height: 140px;
  overflow-y: auto;
  transition: all 0.2s ease;
}

.speech-interactive-canvas:hover {
  border-color: #cbd5e1;
  background: #ffffff;
}

.speech-word-node {
  display: inline-flex;
  align-items: center;
  padding: 1px 3px;
  margin: 1px 2px;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.speech-word-node:hover {
  background: #fef08a;
  color: #854d0e;
  transform: translateY(-1px);
}

.speech-word-node.is-pre-anchor {
  color: #475569;
}

.speech-word-node.is-anchor-node {
  background: linear-gradient(135deg, #fef08a 0%, #fde047 100%);
  color: #713f12;
  font-weight: 700;
  padding: 2px 6px;
  border: 1px solid #eab308;
  box-shadow: 0 1px 3px rgba(234, 179, 8, 0.25);
  border-radius: 5px;
}

.anchor-pin-flag {
  font-size: 11px;
  margin-right: 3px;
}

.speech-empty-tip {
  font-size: 12px;
  color: #94a3b8;
  text-align: center;
  padding: 12px 0;
}

/* 划选浮动操作条 */
.selection-floating-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #eff6ff;
  border: 1px solid #bfdbfe;
  padding: 6px 12px;
  border-radius: 6px;
  animation: fadeIn 0.2s ease;
}

.selection-tip {
  font-size: 12px;
  color: #1e40af;
}

.btn-bind-selection {
  background: #2563eb;
  color: #ffffff;
  border: none;
  padding: 3px 10px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s ease;
}

.btn-bind-selection:hover {
  background: #1d4ed8;
}

/* 智能候选推荐 */
.candidate-keyword-bar {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  flex-wrap: wrap;
}

.candidate-label {
  font-size: 11.5px;
  font-weight: 600;
  color: #64748b;
  margin-top: 3px;
  white-space: nowrap;
}

.candidate-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.cand-chip {
  background: #f1f5f9;
  border: 1px solid #e2e8f0;
  color: #334155;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 12px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.cand-chip:hover {
  background: #e2e8f0;
  border-color: #cbd5e1;
  color: #0f172a;
}

.cand-chip.is-active {
  background: #22c55e;
  border-color: #16a34a;
  color: #ffffff;
  font-weight: 600;
}

.no-cand-text {
  font-size: 11px;
  color: #94a3b8;
}

/* 输入与微调控制行 */
.trigger-input-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.input-col,
.adjust-col {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.input-label {
  font-size: 11.5px;
  font-weight: 600;
  color: #475569;
}

.offset-val {
  color: #0284c7;
  font-weight: 700;
  margin-left: 4px;
}

.trigger-input-wrap {
  position: relative;
  display: flex;
  align-items: center;
}

.anchor-text-input {
  width: 100%;
  height: 32px;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  padding: 4px 28px 4px 10px;
  font-size: 13px;
  background: #ffffff;
  color: #0f172a;
  outline: none;
  transition: all 0.15s ease;
}

.anchor-text-input:focus {
  border-color: #2563eb;
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.15);
}

.btn-clear-input {
  position: absolute;
  right: 8px;
  background: none;
  border: none;
  color: #94a3b8;
  cursor: pointer;
  font-size: 12px;
  padding: 2px;
}

.btn-clear-input:hover {
  color: #ef4444;
}

.fine-tune-steppers {
  display: flex;
  gap: 4px;
}

.step-chip {
  flex: 1;
  height: 32px;
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 500;
  color: #475569;
  cursor: pointer;
  transition: all 0.15s ease;
}

.step-chip:hover {
  background: #f1f5f9;
  border-color: #cbd5e1;
}

.step-chip.active {
  background: #0284c7;
  border-color: #0369a1;
  color: #ffffff;
  font-weight: 700;
}

/* 动态演算明细卡片 */
.dynamic-timing-card {
  background: linear-gradient(135deg, #f0fdf4 0%, #ecfdf5 100%);
  border: 1px solid #a7f3d0;
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.timing-card-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 700;
  color: #065f46;
}

.card-icon {
  font-size: 14px;
}

.timing-metrics-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;
}

.metric-item {
  display: flex;
  flex-direction: column;
  background: rgba(255, 255, 255, 0.7);
  padding: 6px 8px;
  border-radius: 6px;
  border: 1px solid #d1fae5;
}

.metric-item.highlight {
  background: #ffffff;
  border-color: #34d399;
  box-shadow: 0 1px 3px rgba(16, 185, 129, 0.15);
}

.metric-label {
  font-size: 10.5px;
  color: #64748b;
  margin-bottom: 2px;
}

.metric-value {
  font-size: 13.5px;
  font-weight: 700;
  color: #1e293b;
}

.metric-value.primary {
  color: #059669;
  font-size: 15px;
}

.metric-sub {
  font-size: 10px;
  color: #94a3b8;
  margin-top: 1px;
}

/* 警告卡片 */
.unmatched-warning-card {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  background: #fffbeb;
  border: 1px solid #fde68a;
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 12px;
  color: #92400e;
  line-height: 1.5;
}

.warn-icon {
  font-size: 14px;
  margin-top: 1px;
}

/* 底部操作栏 */
.config-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 8px;
  border-top: 1px solid #f1f5f9;
}

.btn-unlink {
  background: none;
  border: none;
  color: #94a3b8;
  font-size: 12px;
  cursor: pointer;
  padding: 4px 6px;
  border-radius: 4px;
}

.btn-unlink:hover {
  color: #ef4444;
  background: #fef2f2;
}

.footer-right {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-left: auto;
}

.footer-summary {
  font-size: 11.5px;
  color: #475569;
}

.btn-confirm-apply {
  background: #059669;
  color: #ffffff;
  border: none;
  font-size: 12px;
  font-weight: 600;
  padding: 5px 14px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.15s ease;
}

.btn-confirm-apply:hover {
  background: #047857;
}

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(2px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
