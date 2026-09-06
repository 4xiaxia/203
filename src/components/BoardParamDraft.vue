<script setup>
import RealBoardPreview from './RealBoardPreview.vue'
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
// 截图统一通过 window.snapdom.toPng，不引用第三方包
import {
  ArrowLeftOutlined,
  CameraOutlined,
  CopyOutlined,
  DeleteOutlined,
  PlusOutlined,
  RobotOutlined,
  SaveOutlined,
  SettingOutlined,
} from '@ant-design/icons-vue'
import {
  readStep1Handoff,
  STEP1_HANDOFF_EVENT,
  clearStep1Handoff,
} from '../services/stepHandoff'
import { renderProblemHtml } from '../utils/mathText'
import {
  generateAgentBV2Rows,
  loadAgentBV2Config,
  saveAgentBV2Config,
} from '../agent-b-v2/service.js'
import { normalizeAgentBV2BoardCells } from '../agent-b-v2/contract.js'
import {
  userApiConfig,
  saveUserApiConfig,
  subscribeUserApiConfig,
} from '../lib/userApiConfig.js'
import {
  ensureHandwritingFont,
  HANDWRITING_FONTS,
  loadBoardTypographyConfig,
  saveBoardTypographyConfig,
} from '../board-tools/boardTypography'

const DRAFT_STORAGE_KEY = 'qinghuabu.boardParamDraft.rows.v10'
const emit = defineEmits(['back-to-step1'])

const handoff = ref(readStep1Handoff())
const showGrid = ref(handoff.value?.showGrid ?? true)
const showGuides = ref(true)
const activeBoardPlan = computed(() => handoff.value?.boardPlan || null)
const typographyConfig = reactive(loadBoardTypographyConfig())
const activeRowKey = ref('')
const previewCaptureRef = ref(null)
const previewDataUrl = ref('')
const captureState = ref('idle')
const generationState = ref('idle')
const generationError = ref('')
const generatedModel = ref('')
const extraNote = ref('')
const agentConfigOpen = ref(false)

const stageOptions = [
  { value: '题目', label: '题目' },
  { value: '分析', label: '分析' },
  { value: '解答', label: '解答' },
  { value: '答语', label: '答语' },
  { value: '总结', label: '总结' },
]

function emptyRow(partial = {}) {
  return {
    key: partial.key || `row-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
    duration: partial.duration || '待程序预估',
    stage: partial.stage || '分析',
    notes: partial.notes || '',
    speech: partial.speech || '',
    board: partial.board || '',
    actionSpec: partial.actionSpec || '',
    timingStatus: partial.timingStatus || '',
    timingSource: partial.timingSource || '',
    speechCharacters: Number(partial.speechCharacters || 0),
    estimatedDurationMs: Number(partial.estimatedDurationMs || 0),
  }
}

function defaultRows() {
  return []
}

function loadRows() {
  const h = handoff.value
  try {
    const raw = localStorage.getItem(DRAFT_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed?.problemText === h?.problemText && Array.isArray(parsed?.rows) && parsed.rows.length) {
        return normalizeAgentBV2BoardCells(parsed.rows).map((row) => emptyRow(row))
      }
    }
  } catch {}
  return defaultRows()
}

const rows = ref(loadRows())

const columns = [
  { title: '时间', dataIndex: 'duration', key: 'duration', width: 130 },
  { title: '环节', dataIndex: 'stage', key: 'stage', width: 90 },
  { title: '注意事项', dataIndex: 'notes', key: 'notes', width: 150 },
  { title: '语音口播稿', dataIndex: 'speech', key: 'speech', width: 260 },
  { title: '板书内容', dataIndex: 'board', key: 'board', width: 400 },
  { title: '板书动作', dataIndex: 'actionSpec', key: 'actionSpec', width: 280 },
]

const problemHtml = computed(() =>
  renderProblemHtml(handoff.value?.problemText || ''),
)
const typeLabel = computed(
  () =>
    ({ geometry: '几何题', calculation: '计算运算题', word: '应用题', other: '其他' })[
      handoff.value?.problemType
    ] || handoff.value?.problemType || '几何题',
)
const focusLabel = computed(
  () =>
    ({
      geometry_diagram: '几何图解',
      calculation_process: '演算过程',
      relation_understanding: '关系理解',
      mixed: '综合',
    })[handoff.value?.boardFocus] || handoff.value?.boardFocus || '几何图解',
)

const topicAnchor = computed(() => handoff.value?.topicLayout?.question || null)

const agentConfig = reactive(loadAgentBV2Config())
const handoffReady = computed(() => Boolean(
  handoff.value?.problemText?.trim() &&
  handoff.value?.topicLayout?.question &&
  handoff.value?.boardPlan,
))

async function onHandwritingFontChange(fontId) {
  try {
    await ensureHandwritingFont(fontId)
    typographyConfig.fontId = fontId
    saveBoardTypographyConfig(typographyConfig)
    message.success('板书字体已更新')
  } catch (error) {
    message.error(error?.message || '板书字体加载失败')
  }
}

function refreshHandoff() {
  handoff.value = readStep1Handoff()
  showGrid.value = handoff.value?.showGrid ?? true
  previewDataUrl.value = ''
  rows.value = loadRows()
}
function onHandoffEvent(e) {
  handoff.value = e?.detail || readStep1Handoff()
  showGrid.value = handoff.value?.showGrid ?? true
  previewDataUrl.value = ''
  rows.value = loadRows()
}
onMounted(() => {
  ensureHandwritingFont(typographyConfig.fontId).catch(() => {})
  window.addEventListener(STEP1_HANDOFF_EVENT, onHandoffEvent)
  window.addEventListener('storage', refreshHandoff)
})
onUnmounted(() => {
  window.removeEventListener(STEP1_HANDOFF_EVENT, onHandoffEvent)
  window.removeEventListener('storage', refreshHandoff)
})

watch(
  [rows],
  ([rowValues]) => {
    localStorage.setItem(
      DRAFT_STORAGE_KEY,
      JSON.stringify({
        problemText: handoff.value?.problemText || '',
        handoffConfirmedAt: handoff.value?.confirmedAt || '',
        rows: rowValues,
        updatedAt: new Date().toISOString(),
      }),
    )
  },
  { deep: true },
)

watch(
  [handoff, activeBoardPlan, showGrid, showGuides],
  () => {
    previewDataUrl.value = ''
    captureState.value = 'idle'
  },
  { deep: true, immediate: true },
)

function addRow() {
  rows.value.push(emptyRow({ stage: '分析' }))
}
function removeRow(key) {
  rows.value = rows.value.filter((r) => r.key !== key)
}
function downloadSpeech() {
  const withSpeech = rows.value.filter((r) => (r.speech ?? '').trim())
  if (!withSpeech.length) {
    message.warning('没有可导出的口播稿内容')
    return
  }
  const problem = (handoff.value?.problemText || '').trim()
  const now = new Date().toLocaleString('zh-CN', { hour12: false })
  const lines = [
    `# 口播稿`,
    ``,
    `> 题目：${problem || '未提供'}`,
    `> 导出时间：${now}`,
    `> 共 ${withSpeech.length} 行`,
    ``,
    `---`,
    ``,
  ]
  for (const r of withSpeech) {
    const stage = r.stage || '未分'
    const duration = r.duration && r.duration !== '待程序预估' ? r.duration : ''
    const notes = (r.notes ?? '').trim()
    const speech = (r.speech ?? '').trim()
    lines.push(`## 【${stage}】${duration ? ` ${duration}` : ''}`)
    if (notes) lines.push(`> 注意：${notes}`)
    lines.push(``)
    lines.push(speech)
    lines.push(``)
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `口播稿_${new Date().toISOString().slice(0, 10)}.md`
  a.click()
  URL.revokeObjectURL(a.href)
  message.success(`口播稿已导出（${withSpeech.length} 行）`)
}
function copySpeech(record) {
  const text = (record.speech ?? '').trim()
  if (!text) return
  navigator.clipboard.writeText(text).then(
    () => message.success('口播稿已复制到剪贴板'),
    () => message.error('复制失败，请手动复制')
  )
}
function saveDraft() {
  if (!rows.value.length) {
    message.warning('当前真题还没有生成书稿')
    return
  }
  message.success('7列表书稿已保存（本机）')
}
function saveAgentConfigAtPage() {
  saveAgentBV2Config(agentConfig)
  saveUserApiConfig()
  message.success('Agent B V2 配置已保存（Key 全局生效）')
}

// 订阅全局 userApiConfig 变化（跨标签同步）—— 仅触发响应式更新
subscribeUserApiConfig(() => {})
async function capturePreview() {
  if (!handoffReady.value) {
    message.warning('请先从第1步带入题目')
    return ''
  }
  if (!window.snapdom?.toPng) {
    generationError.value = 'window.snapdom.toPng 未载入'
    message.error('截图组件未就绪')
    return ''
  }
  captureState.value = 'loading'
  generationError.value = ''
  try {
    await nextTick()
    await document.fonts?.ready
    const img = await window.snapdom.toPng(previewCaptureRef.value, {
      backgroundColor: '#ffffff',
      embedFonts: false,
    })
    const dataUrl = img?.src ?? ''
    previewDataUrl.value = dataUrl
    captureState.value = 'ready'
    message.success('真画布预览已截取')
    return dataUrl
  } catch (error) {
    captureState.value = 'error'
    generationError.value = error?.message || String(error)
    message.error('预览截取失败')
    return ''
  }
}
async function generateTable() {
  if (generationState.value === 'loading') return
  saveAgentBV2Config(agentConfig)
  generationState.value = 'loading'
  generationError.value = ''
  try {
    const image = previewDataUrl.value || (await capturePreview())
    if (!image) {
      generationState.value = captureState.value === 'error' ? 'error' : 'idle'
      return
    }
    const result = await generateAgentBV2Rows({
      config: agentConfig,
      handoff: handoff.value,
      previewDataUrl: image,
      fontId: typographyConfig.fontId,
      extraNote: extraNote.value,
      currentTime: new Date().toISOString(),
    })
    rows.value = result.rows.map((row) => emptyRow(row))
    generatedModel.value = result.model
    generationState.value = 'ready'
    message.success(`已生成 ${rows.value.length} 行七列表`)
  } catch (error) {
    generationState.value = 'error'
    generationError.value = error?.message || String(error)
    message.error(generationError.value)
  }
}
function onPickCoord(c) {
  const text =
    '起笔 表(' + c.refX + ',' + c.refY + ') → 画布(' + c.px + ',' + c.py + ')px / (' + c.xPct + ',' + c.yPct + ')%'
  navigator.clipboard?.writeText(text)
  message.success('已复制起笔坐标')
}

function back() {
  emit('back-to-step1')
}
function clearAndBack() {
  clearStep1Handoff()
  rows.value = []
  localStorage.removeItem(DRAFT_STORAGE_KEY)
  message.info('已清空，回第1步')
  emit('back-to-step1')
}
</script>

<template>
  <a-layout class="qh-page">
    <a-layout-header class="qh-page-header">
      <div class="qh-brand">
        <span class="qh-brand-mark">教学板书</span>
        <a-tag color="geekblue">第2步 · 板书参数书稿</a-tag>
        <a-typography-text type="secondary">生成并审核七列讲题执行表</a-typography-text>
      </div>
      <a-space>
        <a-button @click="back">
          <template #icon><ArrowLeftOutlined /></template>
          返回第1步
        </a-button>
        <a-button @click="agentConfigOpen = true">
          <template #icon><SettingOutlined /></template>
          Agent 设置
        </a-button>
        <a-button type="primary" :disabled="!rows.length" @click="saveDraft">
          <template #icon><SaveOutlined /></template>
          保存书稿
        </a-button>
      </a-space>
    </a-layout-header>

    <a-layout-content class="qh-page-content">
      <a-alert
        v-if="!handoffReady"
        type="warning"
        show-icon
        class="top-alert"
        message="等待第1步交接"
        description="第1步确认快照不完整；请返回原步骤重新预览确认，本页不做默认补算。"
      />

      <a-row :gutter="[16, 16]">
        <a-col :xs="{ span: 24, order: 2 }" :xl="{ span: 9, order: 1 }">
          <a-card :bordered="false" class="preview-card">
            <template #title>
              <span>真画布预览</span>
              <a-typography-text type="secondary" class="sub">完整继承第1步</a-typography-text>
            </template>
            <template #extra>
              <a-space>
                <a-switch v-model:checked="showGrid" checked-children="网格" un-checked-children="网格" size="small" />
                <a-switch v-model:checked="showGuides" checked-children="分区" un-checked-children="分区" size="small" />
              </a-space>
            </template>
            <a-descriptions size="small" :column="{ xs: 1, sm: 2, lg: 3 }" class="handoff-meta">
              <a-descriptions-item label="数据来源">
                <a-tag color="success">第1步真识别交接</a-tag>
              </a-descriptions-item>
              <a-descriptions-item label="题型">{{ typeLabel }}</a-descriptions-item>
              <a-descriptions-item label="板书侧重">{{ focusLabel }}</a-descriptions-item>
              <a-descriptions-item label="题目锚">
                <template v-if="topicAnchor">
                  ({{ Number(topicAnchor.x).toFixed(1) }}, {{ Number(topicAnchor.y).toFixed(1) }})%
                </template>
                <a-tag v-else color="error">缺失</a-tag>
              </a-descriptions-item>
              <a-descriptions-item label="四标签">
                <a-tag :color="handoff?.boardPlan ? 'success' : 'warning'">
                  {{ handoff?.boardPlan ? '已确认' : '缺失' }}
                </a-tag>
              </a-descriptions-item>
              <a-descriptions-item label="板书字体">
                <a-select
                  :value="typographyConfig.fontId"
                  style="min-width: 180px"
                  @change="onHandwritingFontChange"
                >
                  <a-select-option v-for="font in HANDWRITING_FONTS" :key="font.id" :value="font.id">
                    <span :style="{ fontFamily: font.family }">{{ font.label }}</span>
                  </a-select-option>
                </a-select>
              </a-descriptions-item>
              <a-descriptions-item label="原图层">
                {{ handoff?.keepOriginal && handoff?.sourceImageDataUrl ? '已继承' : '不需要' }}
              </a-descriptions-item>
              <a-descriptions-item label="画布">1726 × 980</a-descriptions-item>
            </a-descriptions>

            <div v-if="handoffReady" ref="previewCaptureRef" class="preview-capture">
              <RealBoardPreview
                :problem-text="handoff?.problemText || ''"
                :board-plan="activeBoardPlan"
                :topic-layout="handoff?.topicLayout"
                :show-all-labels="true"
                :show-grid="showGrid"
                :show-zone-guides="showGuides"
                :source-image-url="handoff?.sourceImageDataUrl || ''"
                :keep-original="Boolean(handoff?.keepOriginal)"
                interactive
                @pick-coord="onPickCoord"
              />
            </div>

            <div class="preview-actions">
              <a-space wrap>
                <a-button :loading="captureState === 'loading'" :disabled="!handoffReady" @click="capturePreview">
                  <template #icon><CameraOutlined /></template>
                  截取当前预览
                </a-button>
                <a-tag :color="previewDataUrl ? 'success' : 'default'">
                  {{ previewDataUrl ? '预览已送入 Agent B' : '尚未截取' }}
                </a-tag>
              </a-space>
              <a-typography-text type="secondary" class="coord-tip">
                点击画布可复制起笔坐标
              </a-typography-text>
            </div>
          </a-card>
        </a-col>

        <a-col :xs="{ span: 24, order: 1 }" :xl="{ span: 15, order: 2 }">
          <a-card :bordered="false" class="table-card main-table-card">
            <template #title>
              <span>七列讲题执行表</span>
              <a-typography-text type="secondary" class="sub">
                时间 | 环节 | 注意事项 | 语音口播稿 | 分析区动作板书 | 解题区板书 | 板书动作
              </a-typography-text>
            </template>
            <template #extra>
              <a-space wrap>
                <a-button
                  type="primary"
                  :loading="generationState === 'loading'"
                  :disabled="!handoffReady"
                  @click="generateTable"
                >
                  <template #icon><RobotOutlined /></template>
                  生成七列表
                </a-button>
                <a-button size="small" type="dashed" @click="addRow">
                  <template #icon><PlusOutlined /></template>
                  补一行
                </a-button>
                <a-button size="small" danger :disabled="!activeRowKey" @click="removeRow(activeRowKey)">
                  <template #icon><DeleteOutlined /></template>
                  删除选中行
                </a-button>

              </a-space>
            </template>

            <a-table
              :columns="columns"
              :data-source="rows"
              :pagination="false"
              :scroll="{ x: 1380, y: 520 }"
              size="small"
              bordered
              row-key="key"
              :row-class-name="(record) => (record.key === activeRowKey ? 'row-active' : '')"
              :custom-row="(record) => ({ onClick: () => (activeRowKey = record.key) })"
            >
              <template #bodyCell="{ column, record }">
                <template v-if="column.dataIndex === 'duration'">
                  <a-input v-model:value="record.duration" placeholder="待程序预估" />
                </template>
                <template v-else-if="column.dataIndex === 'stage'">
                  <a-select v-model:value="record.stage" style="width: 100%" :options="stageOptions" />
                </template>
                <template v-else-if="column.dataIndex === 'notes'">
                  <a-textarea v-model:value="record.notes" :rows="3" placeholder="教学重点、易错点、单位" />
                </template>
                <template v-else-if="column.dataIndex === 'speech'">
                  <div style="display: flex; flex-direction: column; gap: 4px;">
                    <a-textarea v-model:value="record.speech" :rows="4" placeholder="可直接朗读的语音口播稿" />
                    <a-button size="small" type="link" :disabled="!record.speech?.trim()" @click="copySpeech(record)" style="align-self: flex-end; padding: 0;">
                      <template #icon><CopyOutlined /></template>
                      复制此口播
                    </a-button>
                  </div>
                </template>
                <template v-else-if="column.dataIndex === 'board'">
                  <a-textarea v-model:value="record.board" :rows="4" placeholder="本行板书内容描述（落区由 actionSpec 的 region 决定）" />
                </template>
                <template v-else-if="column.dataIndex === 'actionSpec'">
                  <a-textarea v-model:value="record.actionSpec" :rows="4" placeholder="触发语句、工具、顺序、定位和颜色" />
                </template>
              </template>
              <template #emptyText>
                <a-empty description="点击“生成七列表”，或先补一行手动填写" />
              </template>
            </a-table>

            <a-alert v-if="generationError" type="error" show-icon :message="generationError" class="agent-error" />
            <div class="table-foot">
              <a-button size="small" type="primary" :disabled="!rows.length" @click="downloadSpeech">
                导出口播稿 (.md)
              </a-button>
              <a-typography-text type="secondary">
                画布 1726 × 980 · 口播按 170 字/分钟预估 · 所有板书动作单手互斥
              </a-typography-text>
              <a-typography-text v-if="generatedModel" type="secondary">
                {{ generatedModel }}<template v-if="rows.length"> · {{ rows.length }} 行</template>
              </a-typography-text>
            </div>
          </a-card>
        </a-col>
      </a-row>

      <a-drawer
        v-model:open="agentConfigOpen"
        title="Agent B V2 设置"
        placement="right"
        :width="480"
      >
        <template #extra>
          <a-button type="primary" @click="saveAgentConfigAtPage">保存配置</a-button>
        </template>
        <a-form :model="agentConfig" layout="vertical" class="agent-form">
          <a-form-item label="Endpoint">
            <a-input v-model:value="agentConfig.endpoint" placeholder="https://api.openai.com/v1/chat/completions" />
          </a-form-item>
          <a-form-item label="Model">
            <a-input v-model:value="agentConfig.model" placeholder="gpt-4o" />
          </a-form-item>
          <a-form-item label="API Key (用户自填)">
            <a-input-password
              v-model:value="userApiConfig.apiKey"
              placeholder="sk-...（仅存浏览器）"
              autocomplete="off"
            />
            <a-typography-text type="secondary" style="font-size:12px">
              Key 全局共享，V2 单阶段生成共用同一份
            </a-typography-text>
          </a-form-item>
          <a-form-item label="Temperature">
            <a-input-number v-model:value="agentConfig.temperature" :min="0" :max="1" :step="0.1" style="width: 100%" />
          </a-form-item>
          <a-form-item label="本题补充要求">
            <a-textarea v-model:value="extraNote" :auto-size="{ minRows: 2, maxRows: 4 }" placeholder="对该题的额外生成要求" />
          </a-form-item>
        </a-form>
      </a-drawer>

    </a-layout-content>
  </a-layout>
</template>

<style scoped>
.top-alert { margin-bottom: 16px; }

.preview-card,
.table-card {
  border-radius: var(--card-radius);
  box-shadow: var(--shadow-md);
  transition: box-shadow 0.2s ease;
}
.preview-card:hover,
.table-card:hover {
  box-shadow: var(--shadow-lg);
}
.table-card { margin-top: 16px; }

.work-panel {
  min-height: 100%;
  padding: 20px;
  border: 1px solid var(--gray-150);
  border-radius: var(--card-radius);
  background: #fff;
}
.work-panel-head,
.work-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.work-panel-head { margin-bottom: 14px; }
.work-panel-head :deep(.ant-typography) { margin: 0; }

.sub { margin-left: 8px; font-size: var(--text-xs); color: var(--gray-400); }
.handoff-meta { margin-bottom: 12px; }

.preview-capture {
  width: 100%;
  min-height: 420px;
  display: grid;
  place-items: center;
  padding: 16px;
  border: 1px solid var(--gray-150);
  border-radius: var(--card-radius-sm);
  background: var(--gray-100);
}
.preview-actions {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
}
.coord-tip { font-size: var(--text-xs); color: var(--gray-400); }
.agent-form :deep(.ant-form-item) { margin-bottom: 10px; }
.agent-form :deep(.ant-form-item-label > label) {
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--gray-700);
}
.agent-error { margin-top: 12px; }
.generated-meta { display: block; margin-top: 10px; font-size: var(--text-xs); }
.table-foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--gray-100);
}
:deep(.row-active) td { background: var(--blue-50) !important; }

/* 七列表格 */
:deep(.ant-table-thead > tr > th) {
  background: var(--gray-50);
  font-weight: 600;
  font-size: var(--text-xs);
  color: var(--gray-500);
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
:deep(.ant-table-tbody > tr > td) {
  font-size: var(--text-sm);
  vertical-align: top;
}
:deep(.ant-table-tbody > tr:hover > td) {
  background: var(--blue-50);
}
:deep(.ant-table-tbody > tr > td .ant-textarea) {
  font-size: var(--text-sm);
  line-height: 1.6;
}

@media (max-width: 768px) {
  .preview-capture { min-height: 240px; padding: 10px; }
  .preview-actions,
  .table-foot,
  .work-actions { align-items: stretch; flex-direction: column; }
}
</style>
