/* @qh-core LANE=SHARED POINT=TOOL_CATALOG only registered actions for B script
 * @pipeline-optimized 批量准备 + 容错处理
 */
import { createHandActionScheduler } from './handActionScheduler.js'
import { createTextTargetRegistry } from './textTargetRegistry.js'
import {
  getRoughNotationAgentTool,
  prepareRoughNotationAction,
  ROUGH_NOTATION_TOOL_ID,
  validateRoughNotationAction,
} from './roughNotationTool.js'
import {
  getRoughDrawingAgentTools,
  prepareRoughDrawingAction,
  ROUGH_DRAWING_TOOL_IDS,
  validateRoughDrawingAction,
} from './roughDrawingTool.js'

export const BOARD_TOOL_CATALOG_VERSION = '1.4.0'

export function getAgentBoardToolCatalog() {
  return {
    version: BOARD_TOOL_CATALOG_VERSION,
    rule: '只能使用 tools 中已声明的工具和 action；没有工具就返回缺口，禁止自造调用',
    tools: [getRoughNotationAgentTool(), ...getRoughDrawingAgentTools()],
  }
}

export function getAgentBDirectorView() {
  const catalog = getAgentBoardToolCatalog()
  return {
    version: catalog.version,
    rule: catalog.rule,
    tools: catalog.tools.map(({ id, purpose, actionSchema, actions, example }) => ({
      id,
      purpose,
      actionSchema,
      ...(actions ? { actions } : {}),
      ...(example ? { example } : {}),
    })),
  }
}

export function validateBoardToolAction(action) {
  if (action?.tool === ROUGH_NOTATION_TOOL_ID) return validateRoughNotationAction(action)
  if (ROUGH_DRAWING_TOOL_IDS.includes(action?.tool)) return validateRoughDrawingAction(action)
  return { ok: false, error: `未支持的板书工具: ${action?.tool || '空'}` }
}

export function createBoardToolRuntime({
  resolveTarget,
  resolveRegion,
  resolveCanvas,
  resolveRegionBounds,
  boardPlan,
} = {}) {
  const targetRegistry = typeof resolveTarget === 'function'
    ? null
    : createTextTargetRegistry({ resolveRegion })
  const targetResolver = resolveTarget || targetRegistry.resolve
  const scheduler = createHandActionScheduler()
  const preparedPlans = new Set()

  function prepare(action) {
    if (action?.tool === ROUGH_NOTATION_TOOL_ID) {
      const plan = prepareRoughNotationAction(action, targetResolver)
      preparedPlans.add(plan)
      return plan
    }
    if (ROUGH_DRAWING_TOOL_IDS.includes(action?.tool)) {
      const plan = prepareRoughDrawingAction(action, {
        resolveCanvas,
        resolveRegionBounds: resolveRegionBounds || ((region) => boardPlan?.[region]),
      })
      preparedPlans.add(plan)
      return plan
    }
    throw new Error(`未支持的板书工具: ${action?.tool || '空'}`)
  }

  /* @pipeline-optimized 批量准备：先验证全部，再统一入队，部分失败不阻塞 */
  function prepareAll(actions) {
    const plans = []
    const errors = []
    for (let i = 0; i < actions.length; i++) {
      try {
        plans.push(prepare(actions[i]))
      } catch (error) {
        errors.push({ index: i, error: error?.message || String(error) })
      }
    }
    if (errors.length && plans.length === 0) {
      throw new Error(`全部动作准备失败: ${errors.map(e => e.error).join('; ')}`)
    }
    if (errors.length) {
      console.warn('[BoardToolRuntime] 部分动作准备失败:', errors)
    }
    return plans
  }

  return {
    enqueue(action) {
      const plan = prepare(action)
      return scheduler.enqueue(plan)
    },
    /* @pipeline-optimized 批量准备 + 批量入队 */
    enqueueAll(actions) {
      const plans = prepareAll(actions)
      if (plans.length === 0) return []
      return scheduler.enqueueAll(plans)
    },
    clear() {
      scheduler.cancelAll()
      preparedPlans.forEach((plan) => plan.remove?.())
      preparedPlans.clear()
      targetRegistry?.clear()
    },
    subscribe: scheduler.subscribe,
    getState: scheduler.getState,
    listTargets: () => targetRegistry?.list() || [],
  }
}
