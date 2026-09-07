/**
 * @pipeline-optimized 渲染管道
 * 使用 requestAnimationFrame 批量处理 DOM 写入，减少重排重绘。
 * 将多个动作的 DOM 操作合并到同一帧中执行。
 */

export function createRenderPipeline({ batchSize = 16 } = {}) {
  let pendingActions = []
  let isProcessing = false
  let frameId = null

  function flush() {
    if (pendingActions.length === 0) {
      isProcessing = false
      return
    }

    isProcessing = true
    const batch = pendingActions.splice(0, batchSize)

    for (let i = 0; i < batch.length; i++) {
      try {
        batch[i]()
      } catch (error) {
        console.error('[RenderPipeline] 动作执行失败:', error)
      }
    }

    if (pendingActions.length > 0) {
      frameId = requestAnimationFrame(flush)
    } else {
      isProcessing = false
      frameId = null
    }
  }

  return {
    enqueue(executeFn) {
      pendingActions.push(executeFn)
      if (!isProcessing) {
        isProcessing = true
        frameId = requestAnimationFrame(flush)
      }
    },
    enqueueAll(executeFns) {
      pendingActions.push(...executeFns)
      if (!isProcessing) {
        isProcessing = true
        frameId = requestAnimationFrame(flush)
      }
    },
    clear() {
      pendingActions = []
      if (frameId) {
        cancelAnimationFrame(frameId)
        frameId = null
      }
      isProcessing = false
    },
    getQueueSize() {
      return pendingActions.length
    },
    isProcessing() {
      return isProcessing
    },
  }
}
