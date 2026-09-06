<script setup>
/* @qh-core LANE=DELIVERABLE POINT=VISUAL_TIMELINE
 * 可视化时序对齐组件 (Visual Timeline Component)
 * - 中央轨道 (Central Audio Track) 显示音频进度、时间刻度与当前播放头游标
 * - 上轨 (Upper Track) 显示各分段口播音频块与文字预览
 * - 下轨 (Lower Track) 显示板书动作触发块与落座坐标
 * - 可拖拽段落标记 (Draggable Segment Markers) 对应各步板书起笔时刻，支持精确拖拽对齐与延时微调
 */
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import {
  CaretRightOutlined,
  PauseOutlined,
  StepForwardOutlined,
  StepBackwardOutlined,
  RedoOutlined,
  SaveOutlined,
  SoundOutlined,
  EditOutlined,
  CheckCircleOutlined,
  AimOutlined,
  CompassOutlined,
  ZoomInOutlined,
  ZoomOutOutlined,
  ScissorOutlined,
  CustomerServiceOutlined
} from '@ant-design/icons-vue'
import { message } from 'ant-design-vue'
import { calculateSpeechAnchorTimestamp } from '../agent-b-v2/timing.js'
import KeywordTriggerConfig from './KeywordTriggerConfig.vue'

const props = defineProps({
  rows: {
    type: Array,
    default: () => []
  },
  projectCode: {
    type: String,
    default: 'current'
  },
  activeStep: {
    type: Number,
    default: 0
  }
})

const emit = defineEmits(['update:rows', 'select-step', 'save-sync'])

// 响应式本地行数据
const localRows = ref([])
watch(() => props.rows, (newRows) => {
  if (Array.isArray(newRows)) {
    localRows.value = JSON.parse(JSON.stringify(newRows))
  }
}, { immediate: true, deep: true })

// 演播状态
const activeIndex = ref(props.activeStep || 0)
const isPlaying = ref(false)
const isAutoSequence = ref(false)
const currentTime = ref(0)
const zoomScale = ref(1.0) // 1.0 代表 1秒 = 36px 基础刻度
const snapToDecisecond = ref(true) // 0.1秒磁吸
const audioPlayer = ref(null)
const syncTimer = ref(null)

// 拖拽标记状态
const isDraggingMarker = ref(false)
const draggingIndex = ref(-1)
const dragGhostTime = ref(0)
const timelineTrackRef = ref(null)

// 基础常量：1秒对应的像素宽度 (随 zoomScale 缩放)
const BASE_PIXELS_PER_SEC = 42
const pixelsPerSec = computed(() => BASE_PIXELS_PER_SEC * zoomScale.value)

// 计算各个 step 在总时间线上的时序分布
// 计算各个 step 在总时间线上的时序分布
// 每个 step 占用时长 = audioDuration (或 estimated 5s) + gapSeconds (默认 0.6s)
const timelineSegments = computed(() => {
  let accumSec = 0
  return localRows.value.map((row, idx) => {
    let dur = 5
    if (row.audioDuration) {
      dur = parseFloat(row.audioDuration)
    } else if (row.estimatedDurationMs) {
      dur = Math.round(row.estimatedDurationMs / 100) / 10
    } else if (row.duration) {
      const m = String(row.duration).match(/(\d+(\.\d+)?)/)
      dur = m ? parseFloat(m[1]) : 5
    }

    let rawOffset = row.syncOffset ?? row.startDelay ?? (typeof row.board === 'object' ? (row.board?.syncOffset ?? row.board?.startDelay) : undefined)
    const triggerWord = row.triggerWord || (typeof row.board === 'object' ? row.board?.triggerWord : '') || ''

    // 若有触发词且无显式延时，基于文本定位与标点停顿动态计算起手时间
    if ((rawOffset === undefined || isNaN(rawOffset)) && triggerWord && row.speech) {
      const calc = calculateSpeechAnchorTimestamp(row.speech, triggerWord)
      if (calc.matched) rawOffset = calc.finalOffset
      else rawOffset = 0.2
    }

    const gap = typeof row.gapSeconds === 'number' ? row.gapSeconds : 0.6
    const offset = typeof rawOffset === 'number' ? rawOffset : (rawOffset ? parseFloat(rawOffset) : 0.2)

    const segStart = accumSec
    const segAudioEnd = segStart + dur
    const segTotalEnd = segAudioEnd + gap

    // 板书起笔标记点绝对时间 = segStart + offset
    const markerTime = segStart + Math.max(0, Math.min(dur, offset))

    accumSec = segTotalEnd

    return {
      index: idx,
      row,
      duration: dur,
      gapSeconds: gap,
      syncOffset: offset,
      startDelay: offset,
      triggerWord,
      startTime: segStart,
      audioEndTime: segAudioEnd,
      endTime: segTotalEnd,
      markerTime, // 可拖拽板书标记在总轨上的时间点 (秒)
      stage: row.stage || `步骤${idx + 1}`,
      speech: row.speech || '',
      board: row.board,
      actionSpec: row.actionSpec || [],
      audioUrl: row.audioUrl || ''
    }
  })
})

const totalDuration = computed(() => {
  if (!timelineSegments.value.length) return 0
  const last = timelineSegments.value[timelineSegments.value.length - 1]
  return last ? last.endTime : 0
})

const timelineTrackWidth = computed(() => {
  return Math.max(860, Math.round(totalDuration.value * pixelsPerSec.value) + 120)
})

// 时间刻度线生成 (每 1 秒小刻度，每 5 秒中刻度，每 10 秒大刻度带文字)
const timeTicks = computed(() => {
  const total = Math.ceil(totalDuration.value) + 2
  const ticks = []
  const step = zoomScale.value < 0.8 ? 2 : 1
  for (let s = 0; s <= total; s += step) {
    const isMajor = s % 5 === 0
    const isDeca = s % 10 === 0
    ticks.push({
      sec: s,
      leftPx: Math.round(s * pixelsPerSec.value),
      isMajor,
      isDeca,
      label: formatSeconds(s)
    })
  }
  return ticks
})

// 格式化时间 00:00.0
function formatSeconds(sec) {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function formatDetailedSeconds(sec) {
  const m = Math.floor(sec / 60)
  const s = (sec % 60).toFixed(1)
  return `${String(m).padStart(2, '0')}:${s.padStart(4, '0')}s`
}

// 颜色与分类
function getStageColor(stage) {
  const s = String(stage || '')
  if (s.includes('题') || s.includes('引入') || s.includes('审题')) return '#2563eb'
  if (s.includes('知') || s.includes('链')) return '#059669'
  if (s.includes('析') || s.includes('探') || s.includes('策略')) return '#d97706'
  if (s.includes('解') || s.includes('答') || s.includes('算')) return '#0d9488'
  if (s.includes('总') || s.includes('结') || s.includes('回顾')) return '#7c3aed'
  return '#475569'
}

function getStageBg(stage) {
  const s = String(stage || '')
  if (s.includes('题') || s.includes('引入') || s.includes('审题')) return 'rgba(37, 99, 235, 0.12)'
  if (s.includes('知') || s.includes('链')) return 'rgba(5, 150, 105, 0.12)'
  if (s.includes('析') || s.includes('探') || s.includes('策略')) return 'rgba(217, 119, 6, 0.12)'
  if (s.includes('解') || s.includes('答') || s.includes('算')) return 'rgba(13, 148, 136, 0.12)'
  if (s.includes('总') || s.includes('结') || s.includes('回顾')) return 'rgba(124, 58, 237, 0.12)'
  return 'rgba(71, 85, 105, 0.12)'
}

// 解析板书坐标
function parseBoardCoord(board) {
  if (!board) return { x: null, y: null, text: '', coordStr: '' }
  if (typeof board === 'object') {
    const startCoord = board.startCoord || ''
    const content = board.content || board.text || ''
    if (startCoord) {
      const m = String(startCoord).match(/[\[\(]?\s*([\d.]+)\s*%?\s*,\s*([\d.]+)\s*%?\s*[\]\)]?/)
      if (m) return { x: parseFloat(m[1]), y: parseFloat(m[2]), text: content, coordStr: startCoord }
    }
    if (board.x !== undefined && board.y !== undefined) {
      return { x: parseFloat(board.x), y: parseFloat(board.y), text: content, coordStr: `(${board.x}, ${board.y})` }
    }
    return { x: null, y: null, text: content, coordStr: '' }
  }
  const m = String(board).match(/^\s*[\[\(]?\s*([\d.]+)\s*%?\s*,\s*([\d.]+)\s*%?\s*[\]\)]?\s*(.*)$/s)
  if (m) {
    return { x: parseFloat(m[1]), y: parseFloat(m[2]), text: m[3] || '', coordStr: `(${m[1]}, ${m[2]})` }
  }
  return { x: null, y: null, text: String(board), coordStr: '' }
}

// 选中某个 step
function selectStep(index) {
  if (index < 0 || index >= localRows.value.length) return
  activeIndex.value = index
  emit('select-step', index)

  // 将播放头定位到该 step 起点
  const seg = timelineSegments.value[index]
  if (seg) {
    currentTime.value = seg.startTime
  }
}

// 播放控制
function togglePlay() {
  if (isPlaying.value) {
    pausePlay()
  } else {
    startPlay(false)
  }
}

function startPlay(autoSeq = false) {
  const seg = timelineSegments.value[activeIndex.value]
  if (!seg) return

  if (audioPlayer.value) {
    audioPlayer.value.pause()
  }

  isAutoSequence.value = autoSeq

  if (seg.audioUrl) {
    const audio = new Audio(seg.audioUrl)
    audioPlayer.value = audio
    isPlaying.value = true

    // 如果当前播放头在当前段内，从该偏移开始播
    const localOffset = Math.max(0, currentTime.value - seg.startTime)
    if (localOffset < seg.duration) {
      audio.currentTime = localOffset
    }

    audio.ontimeupdate = () => {
      if (isPlaying.value) {
        currentTime.value = seg.startTime + audio.currentTime
      }
    }

    audio.onended = () => {
      isPlaying.value = false
      currentTime.value = seg.audioEndTime
      if (isAutoSequence.value && activeIndex.value < timelineSegments.value.length - 1) {
        setTimeout(() => {
          activeIndex.value++
          selectStep(activeIndex.value)
          startPlay(true)
        }, seg.gapSeconds * 1000)
      } else {
        isAutoSequence.value = false
      }
    }

    audio.play().catch(() => {
      fallbackSimulatedPlay(seg)
    })
  } else {
    // 无真实音频时使用定时器平滑推进
    fallbackSimulatedPlay(seg)
  }
}

let simulatedTimer = null
function fallbackSimulatedPlay(seg) {
  isPlaying.value = true
  clearInterval(simulatedTimer)
  const stepMs = 50
  simulatedTimer = setInterval(() => {
    if (!isPlaying.value) {
      clearInterval(simulatedTimer)
      return
    }
    currentTime.value += stepMs / 1000
    if (currentTime.value >= seg.audioEndTime) {
      clearInterval(simulatedTimer)
      isPlaying.value = false
      if (isAutoSequence.value && activeIndex.value < timelineSegments.value.length - 1) {
        setTimeout(() => {
          activeIndex.value++
          selectStep(activeIndex.value)
          startPlay(true)
        }, seg.gapSeconds * 1000)
      } else {
        isAutoSequence.value = false
      }
    }
  }, stepMs)
}

function pausePlay() {
  isPlaying.value = false
  isAutoSequence.value = false
  if (audioPlayer.value) {
    audioPlayer.value.pause()
  }
  clearInterval(simulatedTimer)
  clearTimeout(syncTimer.value)
}

function stopPlay() {
  pausePlay()
  currentTime.value = 0
  activeIndex.value = 0
}

function stepForward() {
  if (activeIndex.value < localRows.value.length - 1) {
    selectStep(activeIndex.value + 1)
  }
}

function stepBackward() {
  if (activeIndex.value > 0) {
    selectStep(activeIndex.value - 1)
  }
}

// 点击中央轨道跳转播放头
function onTrackClick(e) {
  if (isDraggingMarker.value) return
  const trackEl = timelineTrackRef.value
  if (!trackEl) return
  const rect = trackEl.getBoundingClientRect()
  const clickX = e.clientX - rect.left + trackEl.scrollLeft
  const targetSec = Math.max(0, Math.min(totalDuration.value, clickX / pixelsPerSec.value))
  currentTime.value = Math.round(targetSec * 10) / 10

  // 定位到所在 step
  const foundIdx = timelineSegments.value.findIndex(s => currentTime.value >= s.startTime && currentTime.value <= s.endTime)
  if (foundIdx !== -1 && foundIdx !== activeIndex.value) {
    activeIndex.value = foundIdx
    emit('select-step', foundIdx)
  }
}

/* ==========================================================
   🎯 核心交互：可拖拽段落标记 (Draggable Segment Marker)
   - 对应各步板书起笔时刻
   - 支持沿中央音频轨水平拖拽，实时调整 syncOffset (板书起笔延时)
   ========================================================== */
function onMarkerMouseDown(index, e) {
  e.stopPropagation()
  e.preventDefault()
  isDraggingMarker.value = true
  draggingIndex.value = index
  activeIndex.value = index

  const seg = timelineSegments.value[index]
  if (!seg) return
  dragGhostTime.value = seg.markerTime

  const startX = e.clientX
  const initialOffset = seg.syncOffset

  function onMouseMove(moveEvent) {
    if (!isDraggingMarker.value) return
    const deltaPx = moveEvent.clientX - startX
    const deltaSec = deltaPx / pixelsPerSec.value

    let newOffset = initialOffset + deltaSec
    // 约束在当前段内 [0, 当前段时长]
    newOffset = Math.max(0, Math.min(seg.duration, newOffset))

    if (snapToDecisecond.value) {
      newOffset = Math.round(newOffset * 10) / 10
    }

    dragGhostTime.value = seg.startTime + newOffset

    // 实时更新到 localRows
    if (localRows.value[index]) {
      localRows.value[index].syncOffset = newOffset
      localRows.value[index].startDelay = newOffset
      if (typeof localRows.value[index].board === 'object' && localRows.value[index].board) {
        localRows.value[index].board.syncOffset = newOffset
        localRows.value[index].board.startDelay = newOffset
      }
    }
  }

  function onMouseUp() {
    isDraggingMarker.value = false
    draggingIndex.value = -1
    window.removeEventListener('mousemove', onMouseMove)
    window.removeEventListener('mouseup', onMouseUp)

    // 发射 update 事件通知外部
    emit('update:rows', JSON.parse(JSON.stringify(localRows.value)))
    message.success(`已更新第 ${index + 1} 步板书起笔延时：${localRows.value[index]?.syncOffset?.toFixed(1) || 0.2}s`)
  }

  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)
}

// 微调所选 step 的延时与气口
function adjustActiveOffset(delta) {
  const row = localRows.value[activeIndex.value]
  if (!row) return
  let val = (typeof row.syncOffset === 'number' ? row.syncOffset : 0.2) + delta
  val = Math.max(0, Math.min(5, Math.round(val * 10) / 10))
  row.syncOffset = val
  row.startDelay = val
  if (typeof row.board === 'object' && row.board) {
    row.board.syncOffset = val
    row.board.startDelay = val
  }
  emit('update:rows', JSON.parse(JSON.stringify(localRows.value)))
}

const showTriggerConfig = ref(true)

function onTriggerWordChange(val) {
  const row = localRows.value[activeIndex.value]
  if (!row) return
  const clean = String(val || '').trim()
  row.triggerWord = clean
  if (typeof row.board === 'object' && row.board) {
    row.board.triggerWord = clean
  }
  // 动态根据口播识别位置重新计算落笔时间戳
  if (clean && row.speech) {
    const calc = calculateSpeechAnchorTimestamp(row.speech, clean)
    if (calc.matched) {
      row.syncOffset = calc.finalOffset
      row.startDelay = calc.finalOffset
      if (typeof row.board === 'object' && row.board) {
        row.board.syncOffset = calc.finalOffset
        row.board.startDelay = calc.finalOffset
      }
    }
  }
  emit('update:rows', JSON.parse(JSON.stringify(localRows.value)))
}

function onInspectorTriggerConfigChange(config) {
  const row = localRows.value[activeIndex.value]
  if (!row) return
  const finalOffset = typeof config?.syncOffset === 'number'
    ? config.syncOffset
    : (typeof config?.startDelay === 'number' ? config.startDelay : 0.2)
  const triggerWord = config?.triggerWord || ''
  row.triggerWord = triggerWord
  row.syncOffset = finalOffset
  row.startDelay = finalOffset
  if (typeof row.board === 'object' && row.board) {
    row.board.triggerWord = triggerWord
    row.board.syncOffset = finalOffset
    row.board.startDelay = finalOffset
  }
  emit('update:rows', JSON.parse(JSON.stringify(localRows.value)))
}

function adjustActiveGap(delta) {
  const row = localRows.value[activeIndex.value]
  if (!row) return
  let val = (typeof row.gapSeconds === 'number' ? row.gapSeconds : 0.6) + delta
  val = Math.max(0, Math.min(5, Math.round(val * 10) / 10))
  row.gapSeconds = val
  emit('update:rows', JSON.parse(JSON.stringify(localRows.value)))
}

// 试听当前步动静同步
function previewCurrentStepSync() {
  pausePlay()
  const seg = timelineSegments.value[activeIndex.value]
  if (!seg) return

  currentTime.value = seg.startTime
  startPlay(false)

  // 高亮演示：延时到达时触发板书起手标记
  const offset = seg.syncOffset
  clearTimeout(syncTimer.value)
  syncTimer.value = setTimeout(() => {
    message.info(`✍️ [${offset.toFixed(1)}s] 第 ${activeIndex.value + 1} 步板书起笔触发！`)
  }, offset * 1000)
}

// 缩放控制
function zoomIn() {
  if (zoomScale.value < 2.5) zoomScale.value = Math.round((zoomScale.value + 0.2) * 10) / 10
}
function zoomOut() {
  if (zoomScale.value > 0.5) zoomScale.value = Math.round((zoomScale.value - 0.2) * 10) / 10
}
function zoomReset() {
  zoomScale.value = 1.0
}

// 保存时序设定
async function saveSyncSettings() {
  emit('save-sync', JSON.parse(JSON.stringify(localRows.value)))
  try {
    const res = await fetch('/api/deliverable/update-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectCode: props.projectCode || 'current',
        rows: localRows.value
      })
    })
    const data = await res.json()
    if (data.success) {
      message.success('✓ 时序微调参数已成功持久化保存！')
    } else {
      message.warning('时序已更新至内存，服务端保存提示：' + (data.error || '未返回确认'))
    }
  } catch (e) {
    message.info('时序已在前端应用，可随时导出或同步')
  }
}

onMounted(() => {
  if (localRows.value.length > 0) {
    selectStep(0)
  }
})

onBeforeUnmount(() => {
  pausePlay()
})
</script>

<template>
  <div class="visual-timeline-container" id="visual-timeline-component">
    <!-- 头部工具栏与全局状态 -->
    <div class="vt-header">
      <div class="vt-title-area">
        <div class="vt-main-title">
          <span class="vt-badge-icon">⏱️</span>
          <span class="vt-title-text">动静同步视觉时间轴</span>
          <span class="vt-badge-sub">中央音频轨 · 拖拽板书标记 · 实时时序微调</span>
        </div>
        <div class="vt-status-pill" :class="{ 'is-playing': isPlaying }">
          <span class="status-indicator-dot"></span>
          <span class="status-indicator-text">
            {{ isPlaying ? `正在演播第 ${activeIndex + 1} 步 (${localRows[activeIndex]?.stage || ''})` : '就绪 · 拖动彩色手柄可对齐板书起手时点' }}
          </span>
        </div>
      </div>

      <!-- 播放与缩放控制按钮群 -->
      <div class="vt-toolbar-actions">
        <!-- 播放器主控 -->
        <div class="vt-play-controls">
          <button class="vt-btn vt-btn-icon" :disabled="activeIndex === 0" @click="stepBackward" title="上一步">
            <StepBackwardOutlined />
          </button>
          <button class="vt-btn vt-btn-primary vt-btn-play" @click="togglePlay" :title="isPlaying ? '暂停' : '播放'">
            <PauseOutlined v-if="isPlaying" />
            <CaretRightOutlined v-else />
            <span>{{ isPlaying ? '暂停' : '演播' }}</span>
          </button>
          <button class="vt-btn vt-btn-icon" :disabled="activeIndex >= localRows.length - 1" @click="stepForward" title="下一步">
            <StepForwardOutlined />
          </button>
          <button class="vt-btn vt-btn-icon" @click="stopPlay" title="重置回开头">
            <RedoOutlined />
          </button>
        </div>

        <!-- 当前与总时间读数 -->
        <div class="vt-time-readout">
          <span class="time-now">{{ formatDetailedSeconds(currentTime) }}</span>
          <span class="time-divider">/</span>
          <span class="time-total">{{ formatDetailedSeconds(totalDuration) }}</span>
        </div>

        <!-- 缩放与吸附 -->
        <div class="vt-view-controls">
          <button class="vt-btn vt-btn-sm" @click="zoomOut" title="缩小时间轴 (容纳更长时间)">
            <ZoomOutOutlined />
          </button>
          <span class="zoom-text">{{ Math.round(zoomScale * 100) }}%</span>
          <button class="vt-btn vt-btn-sm" @click="zoomIn" title="放大时间轴 (精确微调)">
            <ZoomInOutlined />
          </button>
          <button class="vt-btn vt-btn-sm" @click="zoomReset" title="恢复默认 100% 视图">1:1</button>
          <button
            class="vt-btn vt-btn-sm"
            :class="{ 'vt-btn-active': snapToDecisecond }"
            @click="snapToDecisecond = !snapToDecisecond"
            title="0.1秒磁吸对齐开关"
          >
            🧲 0.1s吸附
          </button>
        </div>

        <!-- 保存按钮 -->
        <button class="vt-btn vt-btn-emerald" @click="saveSyncSettings" title="保存所有调整后的板书延时与时序参数">
          <SaveOutlined /> 保存时序
        </button>
      </div>
    </div>

    <!-- 主演播与多轨时间轴滚动区 -->
    <div class="vt-scroll-viewport" ref="timelineTrackRef" @click="onTrackClick">
      <div class="vt-tracks-canvas" :style="{ width: `${timelineTrackWidth}px` }">
        <!-- 刻度线标尺 (Time Ruler) -->
        <div class="vt-time-ruler">
          <div
            v-for="tick in timeTicks"
            :key="tick.sec"
            class="vt-tick-mark"
            :class="{ 'is-major': tick.isMajor, 'is-deca': tick.isDeca }"
            :style="{ left: `${tick.leftPx}px` }"
          >
            <div class="tick-line"></div>
            <span v-if="tick.isDeca || (zoomScale >= 1.2 && tick.isMajor)" class="tick-label">
              {{ tick.label }}
            </span>
          </div>
        </div>

        <!-- 轨道一：上轨 · 口播音频轨 (Upper: Voiceover Audio Track) -->
        <div class="vt-track-row vt-audio-lane">
          <div class="vt-lane-label">
            <span class="lane-icon">🎙️</span>
            <span class="lane-name">上轨：口播音频</span>
          </div>
          <div class="vt-lane-content">
            <div
              v-for="seg in timelineSegments"
              :key="`audio-${seg.index}`"
              class="vt-audio-clip"
              :class="{
                'is-active': activeIndex === seg.index,
                'has-real-audio': Boolean(seg.audioUrl)
              }"
              :style="{
                left: `${seg.startTime * pixelsPerSec}px`,
                width: `${Math.max(64, seg.duration * pixelsPerSec)}px`,
                borderColor: getStageColor(seg.stage)
              }"
              @click.stop="selectStep(seg.index)"
              :title="`第${seg.index + 1}步 [${seg.stage}] 时长:${seg.duration.toFixed(1)}s`"
            >
              <div class="clip-header">
                <span class="clip-step-badge" :style="{ background: getStageColor(seg.stage) }">
                  #{{ seg.index + 1 }} {{ seg.stage }}
                </span>
                <span class="clip-dur-badge">
                  {{ seg.duration.toFixed(1) }}s
                  <SoundOutlined v-if="seg.audioUrl" style="color: #059669; margin-left: 2px;" />
                </span>
              </div>
              <div class="clip-text-snippet">
                {{ seg.speech }}
              </div>
              <div class="clip-waveform-sim">
                <span v-for="w in 12" :key="w" class="wave-bar" :style="{ height: `${25 + ((w * 17) % 65)}%` }"></span>
              </div>
            </div>
          </div>
        </div>

        <!-- 轨道二：中央基准轨 · 音频进度与时间同步轨 (Center: Central Audio Track) -->
        <div class="vt-track-row vt-central-lane">
          <div class="vt-lane-label">
            <span class="lane-icon">⏱️</span>
            <span class="lane-name">中央轨：进度与标记</span>
          </div>
          <div class="vt-lane-content vt-central-content">
            <!-- 槽位基底与段落阴影 -->
            <div class="central-track-base">
              <div
                v-for="seg in timelineSegments"
                :key="`bg-${seg.index}`"
                class="central-seg-slot"
                :style="{
                  left: `${seg.startTime * pixelsPerSec}px`,
                  width: `${(seg.endTime - seg.startTime) * pixelsPerSec}px`
                }"
              >
                <div
                  class="central-seg-active-fill"
                  :style="{
                    width: `${seg.duration * pixelsPerSec}px`,
                    background: getStageBg(seg.stage)
                  }"
                ></div>
                <div
                  class="central-seg-gap-fill"
                  :style="{
                    left: `${seg.duration * pixelsPerSec}px`,
                    width: `${seg.gapSeconds * pixelsPerSec}px`
                  }"
                  title="组间留白气口"
                ></div>
              </div>
            </div>

            <!-- 音频全局播放进度高亮条 -->
            <div
              class="central-playback-fill"
              :style="{ width: `${currentTime * pixelsPerSec}px` }"
            ></div>

            <!-- 可拖拽段落标记 (Draggable Segment Markers for Board Writing Steps) -->
            <div
              v-for="seg in timelineSegments"
              :key="`marker-${seg.index}`"
              class="vt-segment-marker"
              :class="{
                'is-active': activeIndex === seg.index,
                'is-dragging': isDraggingMarker && draggingIndex === seg.index
              }"
              :style="{
                left: `${seg.markerTime * pixelsPerSec}px`
              }"
              @mousedown="onMarkerMouseDown(seg.index, $event)"
            >
              <!-- 标记针杆 -->
              <div class="marker-stem" :style="{ backgroundColor: getStageColor(seg.stage) }"></div>

              <!-- 标记把手 (Handle) -->
              <div
                class="marker-head"
                :style="{
                  borderColor: getStageColor(seg.stage),
                  color: getStageColor(seg.stage)
                }"
              >
                <div class="marker-icon">✍️</div>
                <div class="marker-label">#{{ seg.index + 1 }}</div>
              </div>

              <!-- 拖拽即时悬浮提示 -->
              <div class="marker-tooltip" v-if="activeIndex === seg.index || (isDraggingMarker && draggingIndex === seg.index)">
                <div class="tooltip-time">{{ formatDetailedSeconds(seg.markerTime) }}</div>
                <div class="tooltip-sub">延时 +{{ seg.syncOffset.toFixed(1) }}s · 拖拽微调</div>
                <div class="tooltip-kw" v-if="seg.triggerWord">关键词：“{{ seg.triggerWord }}”</div>
              </div>
            </div>

            <!-- 全局红色播放头针线 (Playhead Scrubber Needle) -->
            <div
              class="vt-playhead-needle"
              :style="{ left: `${currentTime * pixelsPerSec}px` }"
            >
              <div class="playhead-cap"></div>
              <div class="playhead-line"></div>
              <div class="playhead-time-tag">{{ formatDetailedSeconds(currentTime) }}</div>
            </div>
          </div>
        </div>

        <!-- 轨道三：下轨 · 板书动作轨 (Lower: Board Writing Action Track) -->
        <div class="vt-track-row vt-board-lane">
          <div class="vt-lane-label">
            <span class="lane-icon">✍️</span>
            <span class="lane-name">下轨：板书动作</span>
          </div>
          <div class="vt-lane-content">
            <div
              v-for="seg in timelineSegments"
              :key="`board-${seg.index}`"
              class="vt-board-clip"
              :class="{ 'is-active': activeIndex === seg.index }"
              :style="{
                left: `${seg.markerTime * pixelsPerSec}px`,
                width: `${Math.max(80, (seg.duration - seg.syncOffset + 0.3) * pixelsPerSec)}px`,
                borderColor: getStageColor(seg.stage)
              }"
              @click.stop="selectStep(seg.index)"
            >
              <div class="board-clip-header">
                <span class="board-badge" :style="{ background: getStageColor(seg.stage) }">
                  起手 {{ parseBoardCoord(seg.board).coordStr || (parseBoardCoord(seg.board).x ? `(${parseBoardCoord(seg.board).x}, ${parseBoardCoord(seg.board).y})` : '自适') }}
                </span>
                <span class="board-trigger-badge" v-if="seg.triggerWord">
                  🔑 {{ seg.triggerWord }}
                </span>
                <span class="board-act-count" v-if="seg.actionSpec && seg.actionSpec.length">
                  ⚡ {{ seg.actionSpec.length }}动作
                </span>
              </div>
              <div class="board-clip-text">
                {{ parseBoardCoord(seg.board).text || seg.board || '（无板书内容）' }}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 底部：当前步骤详细对齐微调卡片 (Sync Inspector) -->
    <div class="vt-inspector-card" v-if="timelineSegments[activeIndex]">
      <div class="inspector-header">
        <div class="inspector-title">
          <span class="badge-step-no" :style="{ background: getStageColor(timelineSegments[activeIndex].stage) }">
            第 {{ activeIndex + 1 }} 步
          </span>
          <span class="stage-name-bold">{{ timelineSegments[activeIndex].stage }}</span>
          <span class="time-range-text">
            [{{ formatDetailedSeconds(timelineSegments[activeIndex].startTime) }} ~ {{ formatDetailedSeconds(timelineSegments[activeIndex].endTime) }}]
          </span>
        </div>

        <div class="inspector-actions">
          <button class="btn-tool-subtle" @click="previewCurrentStepSync">
            <CaretRightOutlined /> 试听本步动静对齐
          </button>
        </div>
      </div>

      <div class="inspector-grid">
        <!-- 口播语音详情 -->
        <div class="inspector-box speech-box">
          <div class="box-label">
            <SoundOutlined /> 口播讲授词 (音频时长: {{ timelineSegments[activeIndex].duration.toFixed(1) }}s)
          </div>
          <div class="box-content-text">
            {{ timelineSegments[activeIndex].speech }}
          </div>
        </div>

        <!-- 对应板书详情 -->
        <div class="inspector-box board-box">
          <div class="box-label">
            <EditOutlined /> 对应板书呈现 (起手落点: {{ parseBoardCoord(timelineSegments[activeIndex].board).coordStr || (parseBoardCoord(timelineSegments[activeIndex].board).x ? `(${parseBoardCoord(timelineSegments[activeIndex].board).x}, ${parseBoardCoord(timelineSegments[activeIndex].board).y})` : '自动') }})
          </div>
          <div class="box-content-text board-style">
            {{ parseBoardCoord(timelineSegments[activeIndex].board).text || timelineSegments[activeIndex].board }}
          </div>
        </div>

        <!-- 动静同步微调旋钮 -->
        <div class="inspector-box sync-knobs-box">
          <div class="box-label">
            <AimOutlined /> 精确同步参数调整
          </div>
          <div class="knob-row">
            <div class="knob-item">
              <span class="knob-title">板书起笔延时:</span>
              <div class="knob-stepper">
                <button class="step-btn" @click="adjustActiveOffset(-0.1)">-</button>
                <span class="step-val">{{ (localRows[activeIndex]?.syncOffset ?? 0.2).toFixed(1) }}s</span>
                <button class="step-btn" @click="adjustActiveOffset(0.1)">+</button>
              </div>
              <span class="knob-hint">音频开始后第几秒落笔</span>
            </div>

            <div class="knob-item">
              <span class="knob-title">起手触发关键词:</span>
              <div class="knob-trigger-wrap">
                <input
                  type="text"
                  class="trigger-input"
                  :value="localRows[activeIndex]?.triggerWord || (typeof localRows[activeIndex]?.board === 'object' ? localRows[activeIndex]?.board?.triggerWord : '') || ''"
                  placeholder="如：说明标准以内"
                  @input="onTriggerWordChange($event.target.value)"
                />
              </div>
              <span class="knob-hint">口播念到该词立刻落笔</span>
            </div>

            <div class="knob-item">
              <span class="knob-title">组间衔接气口:</span>
              <div class="knob-stepper">
                <button class="step-btn" @click="adjustActiveGap(-0.1)">-</button>
                <span class="step-val">{{ (localRows[activeIndex]?.gapSeconds ?? 0.6).toFixed(1) }}s</span>
                <button class="step-btn" @click="adjustActiveGap(0.1)">+</button>
              </div>
              <span class="knob-hint">播完后停顿再讲下一步</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 交互式口播文本锚点配置面板 (Keyword-based Trigger Configuration UI) -->
      <div class="inspector-trigger-config-section">
        <div class="trigger-config-header">
          <div class="trigger-config-title">
            <span class="tc-icon">🎯</span>
            <span class="tc-text">口播文本定位与起手时序动态关联配置</span>
            <span class="tc-sub">基于关键词在口播中的精准位置，动态测算起笔时间戳并实现毫秒级微调</span>
          </div>
          <button class="btn-toggle-trigger-config" @click="showTriggerConfig = !showTriggerConfig">
            {{ showTriggerConfig ? '收起配置器 ▴' : '展开互动选词器 ▾' }}
          </button>
        </div>

        <div v-show="showTriggerConfig" class="trigger-config-body">
          <KeywordTriggerConfig
            :speech="localRows[activeIndex]?.speech"
            :trigger-word="localRows[activeIndex]?.triggerWord || (typeof localRows[activeIndex]?.board === 'object' ? localRows[activeIndex]?.board?.triggerWord : '') || ''"
            :sync-offset="localRows[activeIndex]?.syncOffset ?? (typeof localRows[activeIndex]?.board === 'object' ? localRows[activeIndex]?.board?.syncOffset : 0.2)"
            :board-content="localRows[activeIndex]?.board"
            :step-index="activeIndex"
            :step-start-time="timelineSegments[activeIndex]?.startTime"
            inline
            @change="onInspectorTriggerConfigChange"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.visual-timeline-container {
  display: flex;
  flex-direction: column;
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 4px 16px -2px rgba(15, 23, 42, 0.05);
  margin-bottom: 24px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
}

/* 顶部工具栏 */
.vt-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 18px;
  background: #f8fafc;
  border-bottom: 1px solid #e2e8f0;
  gap: 16px;
  flex-wrap: wrap;
}

.vt-title-area {
  display: flex;
  align-items: center;
  gap: 14px;
}

.vt-main-title {
  display: flex;
  align-items: center;
  gap: 6px;
}

.vt-badge-icon {
  font-size: 18px;
}

.vt-title-text {
  font-size: 15px;
  font-weight: 700;
  color: #0f172a;
  letter-spacing: -0.2px;
}

.vt-badge-sub {
  font-size: 12px;
  color: #64748b;
  margin-left: 4px;
}

.vt-status-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  background: #f1f5f9;
  border-radius: 999px;
  font-size: 12px;
  color: #475569;
  font-weight: 500;
  border: 1px solid #e2e8f0;
}

.status-indicator-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #94a3b8;
  transition: all 0.2s ease;
}

.vt-status-pill.is-playing .status-indicator-dot {
  background: #10b981;
  box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.25);
  animation: pulse 1.5s infinite;
}

@keyframes pulse {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.2); opacity: 0.8; }
}

/* 工具栏控制组 */
.vt-toolbar-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.vt-play-controls {
  display: flex;
  align-items: center;
  gap: 4px;
  background: #ffffff;
  padding: 3px;
  border-radius: 8px;
  border: 1px solid #cbd5e1;
}

.vt-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 6px 12px;
  border-radius: 6px;
  border: 1px solid #cbd5e1;
  background: #ffffff;
  color: #334155;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}

.vt-btn:hover:not(:disabled) {
  background: #f1f5f9;
  color: #0f172a;
}

.vt-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.vt-btn-icon {
  width: 32px;
  height: 32px;
  padding: 0;
  border: none;
}

.vt-btn-primary {
  background: #2563eb;
  border-color: #2563eb;
  color: #ffffff;
}

.vt-btn-primary:hover:not(:disabled) {
  background: #1d4ed8;
  color: #ffffff;
}

.vt-btn-emerald {
  background: #059669;
  border-color: #059669;
  color: #ffffff;
}

.vt-btn-emerald:hover {
  background: #047857;
  color: #ffffff;
}

.vt-btn-sm {
  padding: 4px 8px;
  font-size: 12px;
}

.vt-btn-active {
  background: #eff6ff;
  border-color: #3b82f6;
  color: #2563eb;
}

.vt-time-readout {
  display: flex;
  align-items: baseline;
  gap: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 13px;
  background: #ffffff;
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid #e2e8f0;
}

.time-now {
  font-weight: 700;
  color: #0f172a;
}

.time-divider {
  color: #94a3b8;
}

.time-total {
  color: #64748b;
}

.vt-view-controls {
  display: flex;
  align-items: center;
  gap: 4px;
}

.zoom-text {
  font-size: 12px;
  font-weight: 600;
  color: #475569;
  min-width: 38px;
  text-align: center;
}

/* 时间轴可横向滚动区域 */
.vt-scroll-viewport {
  position: relative;
  overflow-x: auto;
  overflow-y: hidden;
  background: #fafafa;
  user-select: none;
  border-bottom: 1px solid #e2e8f0;
}

.vt-scroll-viewport::-webkit-scrollbar {
  height: 8px;
}

.vt-scroll-viewport::-webkit-scrollbar-thumb {
  background: #cbd5e1;
  border-radius: 4px;
}

.vt-scroll-viewport::-webkit-scrollbar-thumb:hover {
  background: #94a3b8;
}

.vt-tracks-canvas {
  position: relative;
  min-height: 250px;
  padding: 0 0 10px 140px; /* 留出左侧轨道标题空间 */
}

/* 时间刻度线 */
.vt-time-ruler {
  position: relative;
  height: 28px;
  border-bottom: 1px solid #e2e8f0;
  background: #f1f5f9;
}

.vt-tick-mark {
  position: absolute;
  top: 0;
  bottom: 0;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
}

.tick-line {
  width: 1px;
  height: 6px;
  background: #cbd5e1;
}

.vt-tick-mark.is-major .tick-line {
  height: 10px;
  background: #94a3b8;
}

.vt-tick-mark.is-deca .tick-line {
  height: 14px;
  background: #475569;
  width: 1.5px;
}

.tick-label {
  font-size: 10px;
  color: #64748b;
  font-family: ui-monospace, monospace;
  margin-top: 1px;
}

/* 轨道行结构 */
.vt-track-row {
  position: relative;
  height: 72px;
  border-bottom: 1px dashed #e2e8f0;
}

.vt-lane-label {
  position: absolute;
  left: -140px;
  top: 0;
  bottom: 0;
  width: 130px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  font-size: 12px;
  font-weight: 700;
  color: #475569;
  background: #f8fafc;
  border-right: 1px solid #e2e8f0;
  box-shadow: 2px 0 4px rgba(0, 0, 0, 0.02);
  z-index: 10;
}

.vt-lane-content {
  position: relative;
  height: 100%;
}

/* 上轨：音频夹子 (Audio Clips) */
.vt-audio-clip {
  position: absolute;
  top: 8px;
  height: 56px;
  background: #ffffff;
  border: 1.5px solid #cbd5e1;
  border-radius: 6px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.04);
  padding: 4px 8px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  cursor: pointer;
  transition: all 0.15s ease;
  overflow: hidden;
}

.vt-audio-clip:hover {
  transform: translateY(-1px);
  box-shadow: 0 3px 8px rgba(0, 0, 0, 0.08);
}

.vt-audio-clip.is-active {
  border-width: 2px;
  background: #f8fafc;
  box-shadow: 0 0 0 2px rgba(37, 99, 235, 0.2);
}

.clip-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.clip-step-badge {
  font-size: 10.5px;
  font-weight: 700;
  color: #ffffff;
  padding: 1px 5px;
  border-radius: 4px;
}

.clip-dur-badge {
  font-size: 10.5px;
  color: #64748b;
  font-family: ui-monospace, monospace;
}

.clip-text-snippet {
  font-size: 11px;
  color: #334155;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 500;
}

.clip-waveform-sim {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 12px;
  opacity: 0.45;
}

.wave-bar {
  flex: 1;
  background: #2563eb;
  border-radius: 1px;
}

/* 中央基准轨 (Central Audio Track) */
.vt-central-lane {
  height: 60px;
  background: #f1f5f9;
  border-bottom: 1px solid #cbd5e1;
}

.central-track-base {
  position: absolute;
  top: 18px;
  height: 24px;
  width: 100%;
}

.central-seg-slot {
  position: absolute;
  top: 0;
  bottom: 0;
}

.central-seg-active-fill {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  border-radius: 3px;
  border: 1px dashed rgba(0, 0, 0, 0.15);
}

.central-seg-gap-fill {
  position: absolute;
  top: 0;
  bottom: 0;
  background: repeating-linear-gradient(45deg, #e2e8f0, #e2e8f0 4px, #cbd5e1 4px, #cbd5e1 8px);
  opacity: 0.5;
}

.central-playback-fill {
  position: absolute;
  top: 26px;
  height: 8px;
  left: 0;
  background: linear-gradient(90deg, #3b82f6, #10b981);
  border-radius: 4px;
  z-index: 2;
  box-shadow: 0 1px 3px rgba(16, 185, 129, 0.4);
}

/* 🎯 可拖拽段落标记 (Draggable Segment Marker) */
.vt-segment-marker {
  position: absolute;
  top: 4px;
  bottom: 0;
  width: 24px;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  cursor: grab;
  z-index: 15;
}

.vt-segment-marker:active,
.vt-segment-marker.is-dragging {
  cursor: grabbing;
}

.marker-stem {
  width: 2px;
  height: 28px;
  background: #2563eb;
  transition: width 0.1s ease;
}

.vt-segment-marker.is-active .marker-stem,
.vt-segment-marker:hover .marker-stem {
  width: 3px;
}

.marker-head {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: #ffffff;
  border: 2px solid #2563eb;
  border-radius: 8px;
  padding: 2px 5px;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.12);
  transition: transform 0.15s ease;
}

.vt-segment-marker:hover .marker-head,
.vt-segment-marker.is-active .marker-head {
  transform: scale(1.15);
  box-shadow: 0 4px 10px rgba(37, 99, 235, 0.25);
}

.marker-icon {
  font-size: 11px;
  line-height: 1;
}

.marker-label {
  font-size: 10px;
  font-weight: 800;
  line-height: 1.1;
  font-family: ui-monospace, monospace;
}

.marker-tooltip {
  position: absolute;
  top: -34px;
  background: #0f172a;
  color: #ffffff;
  padding: 3px 8px;
  border-radius: 4px;
  font-size: 10.5px;
  white-space: nowrap;
  pointer-events: none;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
  z-index: 30;
  text-align: center;
}

.tooltip-time {
  font-weight: 700;
  color: #38bdf8;
  font-family: ui-monospace, monospace;
}

.tooltip-sub {
  font-size: 9.5px;
  color: #cbd5e1;
}

/* 全局播放头红针 (Playhead Needle) */
.vt-playhead-needle {
  position: absolute;
  top: -28px;
  bottom: -72px; /* 贯穿上下三轨 */
  width: 2px;
  transform: translateX(-50%);
  pointer-events: none;
  z-index: 25;
}

.playhead-cap {
  width: 14px;
  height: 14px;
  background: #ef4444;
  clip-path: polygon(0% 0%, 100% 0%, 50% 100%);
  margin-left: -6px;
}

.playhead-line {
  width: 2px;
  height: 100%;
  background: #ef4444;
  box-shadow: 0 0 4px rgba(239, 68, 68, 0.5);
}

.playhead-time-tag {
  position: absolute;
  top: -20px;
  left: 50%;
  transform: translateX(-50%);
  background: #ef4444;
  color: #ffffff;
  font-size: 10px;
  padding: 1px 4px;
  border-radius: 3px;
  font-family: ui-monospace, monospace;
  font-weight: 700;
  white-space: nowrap;
}

/* 下轨：板书动作夹子 */
.vt-board-clip {
  position: absolute;
  top: 8px;
  height: 54px;
  background: #ffffff;
  border: 1.5px solid #0d9488;
  border-radius: 6px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.04);
  padding: 4px 8px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  cursor: pointer;
  transition: all 0.15s ease;
  overflow: hidden;
}

.vt-board-clip:hover {
  transform: translateY(-1px);
  box-shadow: 0 3px 8px rgba(0, 0, 0, 0.08);
}

.vt-board-clip.is-active {
  border-width: 2px;
  box-shadow: 0 0 0 2px rgba(13, 148, 136, 0.25);
  background: #f0fdf4;
}

.board-clip-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.board-badge {
  font-size: 10px;
  font-weight: 700;
  color: #ffffff;
  padding: 1px 4px;
  border-radius: 3px;
}

.board-act-count {
  font-size: 10px;
  color: #059669;
  font-weight: 600;
}

.board-clip-text {
  font-size: 11px;
  color: #1e293b;
  font-family: ui-monospace, monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 底部当前步骤详情视窗 */
.vt-inspector-card {
  padding: 16px 20px;
  background: #ffffff;
  border-top: 1px solid #e2e8f0;
}

.inspector-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.inspector-title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.badge-step-no {
  color: #ffffff;
  font-size: 11.5px;
  font-weight: 700;
  padding: 2px 7px;
  border-radius: 4px;
}

.stage-name-bold {
  font-size: 14px;
  font-weight: 700;
  color: #0f172a;
}

.time-range-text {
  font-size: 12px;
  color: #64748b;
  font-family: ui-monospace, monospace;
}

.btn-tool-subtle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 12px;
  background: #f1f5f9;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  color: #334155;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-tool-subtle:hover {
  background: #e2e8f0;
  color: #0f172a;
}

.inspector-grid {
  display: grid;
  grid-template-columns: 1fr 1fr 280px;
  gap: 14px;
}

@media (max-width: 960px) {
  .inspector-grid {
    grid-template-columns: 1fr;
  }
}

.inspector-box {
  background: #f8fafc;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  padding: 10px 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.box-label {
  font-size: 12px;
  font-weight: 700;
  color: #475569;
  display: flex;
  align-items: center;
  gap: 5px;
}

.box-content-text {
  font-size: 13px;
  line-height: 1.5;
  color: #1e293b;
  max-height: 64px;
  overflow-y: auto;
}

.board-style {
  font-family: ui-monospace, monospace;
  color: #0f766e;
}

/* 微调旋钮 */
.sync-knobs-box {
  background: #f0fdf4;
  border-color: #bbf7d0;
}

.knob-row {
  display: flex;
  align-items: center;
  gap: 12px;
  justify-content: space-around;
  margin-top: 4px;
}

.knob-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
}

.knob-title {
  font-size: 11.5px;
  font-weight: 600;
  color: #166534;
}

.knob-stepper {
  display: flex;
  align-items: center;
  background: #ffffff;
  border: 1px solid #86efac;
  border-radius: 6px;
  overflow: hidden;
}

.step-btn {
  width: 26px;
  height: 26px;
  border: none;
  background: #f0fdf4;
  color: #166534;
  font-weight: bold;
  font-size: 14px;
  cursor: pointer;
  transition: background 0.15s ease;
}

.step-btn:hover {
  background: #dcfce7;
}

.step-val {
  min-width: 44px;
  text-align: center;
  font-size: 12px;
  font-weight: 700;
  color: #0f172a;
  font-family: ui-monospace, monospace;
}

.knob-hint {
  font-size: 10px;
  color: #15803d;
}

.board-trigger-badge {
  font-size: 9.5px;
  padding: 1px 6px;
  border-radius: 4px;
  background: #fef08a;
  color: #854d0e;
  font-weight: 600;
  max-width: 110px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tooltip-kw {
  font-size: 9.5px;
  color: #fde047;
  font-weight: 600;
  margin-top: 1px;
}

.knob-trigger-wrap {
  display: flex;
  align-items: center;
}

.trigger-input {
  width: 110px;
  height: 26px;
  padding: 2px 8px;
  font-size: 11.5px;
  border: 1px solid #86efac;
  border-radius: 6px;
  background: #ffffff;
  color: #0f172a;
  outline: none;
  transition: border-color 0.15s ease;
}

.trigger-input:focus {
  border-color: #16a34a;
  box-shadow: 0 0 0 2px rgba(22, 163, 74, 0.15);
}

/* 交互式触发配置器面板 */
.inspector-trigger-config-section {
  margin-top: 14px;
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  overflow: hidden;
}

.trigger-config-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px;
  background: #f8fafc;
  border-bottom: 1px solid #e2e8f0;
  gap: 12px;
}

.trigger-config-title {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.tc-icon {
  font-size: 14px;
}

.tc-text {
  font-size: 12px;
  font-weight: 700;
  color: #1e293b;
}

.tc-sub {
  font-size: 11px;
  color: #64748b;
  margin-left: 4px;
}

.btn-toggle-trigger-config {
  background: #ffffff;
  border: 1px solid #cbd5e1;
  color: #3b82f6;
  font-size: 11px;
  font-weight: 600;
  padding: 3px 10px;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-toggle-trigger-config:hover {
  background: #eff6ff;
  border-color: #93c5fd;
}

.trigger-config-body {
  padding: 10px 14px 14px;
}
</style>
