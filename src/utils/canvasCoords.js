/**
 * 画布坐标
 * - 甲方真画布：1726 × 980（落最终画面）
 * - 夏夏表稿参考尺寸：1892 × 1044（表里写的像素坐标按此估算）
 * 换算：实际X = 表中X * 1726/1892；实际Y = 表中Y * 980/1044
 *
 * @pipeline-optimized 添加坐标转换缓存，减少重复计算
 */
export const CANVAS_W = 1726
export const CANVAS_H = 980
export const TABLE_REF_W = 1892
export const TABLE_REF_H = 1044
export const SCALE_X = CANVAS_W / TABLE_REF_W
export const SCALE_Y = CANVAS_H / TABLE_REF_H
export const BOARD_DESIGN_SIZE = Object.freeze({ width: CANVAS_W, height: CANVAS_H })

/** 夏夏表稿分区（参考 1892×1044 像素） */
export const ZONE_REF_PX = {
  topic: { name: '题目区', x1: 120, x2: 900, y1: 160, y2: 240 },
  analysis: { name: '分析区', x1: 120, x2: 900, y1: 300, y2: 760 },
  solution: { name: '解题区', x1: 1030, x2: 1740, y1: 280, y2: 790 },
  summary: { name: '总结区', x1: 120, x2: 1740, y1: 830, y2: 920 },
}

/* ====== @pipeline-optimized 坐标缓存 ====== */
const _pctToPxCache = new Map()
const _pxToPctCache = new Map()
const _tablePxCache = new Map()
const CACHE_LIMIT = 512

function cacheSet(cache, key, value) {
  if (cache.size >= CACHE_LIMIT) {
    const firstKey = cache.keys().next().value
    cache.delete(firstKey)
  }
  cache.set(key, value)
}

/** 百分比坐标 → 画布像素坐标（带缓存） */
export function pctToCanvasPx(xPct, yPct) {
  const key = xPct + ',' + yPct
  const cached = _pctToPxCache.get(key)
  if (cached) return cached
  const result = {
    x: Math.round((xPct / 100) * CANVAS_W),
    y: Math.round((yPct / 100) * CANVAS_H),
  }
  cacheSet(_pctToPxCache, key, result)
  return result
}

/** 画布像素坐标 → 百分比坐标（带缓存） */
export function canvasPxToPct(x, y) {
  const key = x + ',' + y
  const cached = _pxToPctCache.get(key)
  if (cached) return cached
  const result = {
    x: Number(((Number(x) / CANVAS_W) * 100).toFixed(2)),
    y: Number(((Number(y) / CANVAS_H) * 100).toFixed(2)),
  }
  cacheSet(_pxToPctCache, key, result)
  return result
}

export function tablePxToCanvasPx(x, y) {
  const key = x + ',' + y
  const cached = _tablePxCache.get(key)
  if (cached) return cached
  const result = {
    x: Math.round(Number(x) * SCALE_X),
    y: Math.round(Number(y) * SCALE_Y),
  }
  cacheSet(_tablePxCache, key, result)
  return result
}

export function tablePxToPct(x, y) {
  const p = tablePxToCanvasPx(x, y)
  return canvasPxToPct(p.x, p.y)
}

export function zoneToPct(zone) {
  const z = ZONE_REF_PX[zone]
  if (!z) return null
  const a = tablePxToPct(z.x1, z.y1)
  const b = tablePxToPct(z.x2, z.y2)
  return {
    name: z.name,
    x: a.x,
    y: a.y,
    w: Number((b.x - a.x).toFixed(2)),
    h: Number((b.y - a.y).toFixed(2)),
    refPx: z,
  }
}

/* 预计算分区缓存（启动时一次） */
const _zonePctCache = {}
export function zoneToPctCached(zone) {
  if (!_zonePctCache[zone]) {
    _zonePctCache[zone] = zoneToPct(zone)
  }
  return _zonePctCache[zone]
}

/* 预计算网格线（启动时一次） */
let _gridLinesCache = null
export function buildGridLines() {
  if (_gridLinesCache) return _gridLinesCache
  const minor = []
  const major = []
  for (let p = 5; p < 100; p += 5) {
    const item = { p, major: p % 10 === 0 }
    if (item.major) major.push(item)
    else minor.push(item)
  }
  _gridLinesCache = { minor, major }
  return _gridLinesCache
}

export function formatTablePx(x, y) {
  const c = tablePxToCanvasPx(x, y)
  const pct = canvasPxToPct(c.x, c.y)
  return `表(${x},${y}) → 画布(${c.x},${c.y})px / (${pct.x},${pct.y})%`
}

/** @pipeline-optimized 清除所有坐标缓存 */
export function clearCoordinateCache() {
  _pctToPxCache.clear()
  _pxToPctCache.clear()
  _tablePxCache.clear()
}
