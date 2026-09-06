import { createHash } from 'crypto'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const AUDIO_CACHE_DIR = resolve(__dirname, '../public/audio-cache')

const DEFAULT_API_KEY = 'sk-fish-9Ex6GP3VFEm25W0_rkBBIfpgLWuT7HrDei7IjVd2DWA'
const DEFAULT_MODEL = 's2.1-pro-free'
const DEFAULT_REFERENCE_ID = '5b00791e193649cd952b48d155fe6b22'

function ensureAudioCacheDir() {
  if (!existsSync(AUDIO_CACHE_DIR)) {
    mkdirSync(AUDIO_CACHE_DIR, { recursive: true })
  }
}

function getAudioHash(text, referenceId, model) {
  return createHash('md5')
    .update(`${text || ''}::${referenceId || ''}::${model || ''}`)
    .digest('hex')
}

function sendJson(res, statusCode, data) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(data))
}

function readJsonBody(req) {
  return new Promise((resolvePromise, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      if (!raw) {
        resolvePromise({})
        return
      }
      try {
        resolvePromise(JSON.parse(raw))
      } catch (err) {
        reject(new Error('Invalid JSON: ' + err.message))
      }
    })
    req.on('error', reject)
  })
}

/**
 * 调用 Fish Audio API 进行语音合成
 */
export async function synthesizeSpeech({
  text,
  referenceId = DEFAULT_REFERENCE_ID,
  model = DEFAULT_MODEL,
  apiKey = process.env.FISH_AUDIO_API_KEY || DEFAULT_API_KEY,
}) {
  if (!text || typeof text !== 'string') {
    throw new Error('缺少有效文本 text')
  }

  ensureAudioCacheDir()
  const cleanText = text.trim()
  const hash = getAudioHash(cleanText, referenceId, model)
  const filename = `${hash}.mp3`
  const filePath = resolve(AUDIO_CACHE_DIR, filename)
  const audioUrl = `/audio-cache/${filename}`

  // 若已缓存且文件有效，直接返回
  if (existsSync(filePath)) {
    try {
      const stat = readFileSync(filePath)
      if (stat && stat.length > 500) {
        return {
          ok: true,
          audioUrl,
          cached: true,
          hash,
          model,
          referenceId,
        }
      }
    } catch {
      // ignore
    }
  }

  // 调取 Fish Audio 官方 TTS 接口
  const response = await fetch('https://api.fish.audio/v1/tts', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'model': model,
    },
    body: JSON.stringify({
      text: cleanText,
      reference_id: referenceId,
      format: 'mp3',
    }),
  })

  if (!response.ok) {
    const errText = await response.text().catch(() => '')
    throw new Error(`Fish Audio API 错误 [${response.status}]: ${errText || response.statusText}`)
  }

  const arrayBuffer = await response.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)
  writeFileSync(filePath, buffer)

  return {
    ok: true,
    audioUrl,
    cached: false,
    hash,
    model,
    referenceId,
  }
}

/**
 * 处理 TTS 相关 HTTP 接口
 */
export async function handleFishAudioRequest(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1')
  const path = url.pathname.replace(/^\/api\/tts/, '')

  // GET /api/tts/info — 获取当前语音配置信息
  if (req.method === 'GET' && (path === '/info' || path === '')) {
    sendJson(res, 200, {
      ok: true,
      provider: 'fish-audio',
      model: DEFAULT_MODEL,
      referenceId: DEFAULT_REFERENCE_ID,
      docs: 'https://docs.fish.audio/developer-guide/getting-started/quickstart',
    })
    return true
  }

  // POST /api/tts/synthesize — 单条文本语音合成
  if (req.method === 'POST' && path === '/synthesize') {
    try {
      const body = await readJsonBody(req)
      const { text, referenceId, model } = body
      const result = await synthesizeSpeech({ text, referenceId, model })
      sendJson(res, 200, result)
      return true
    } catch (error) {
      sendJson(res, 500, {
        ok: false,
        error: error.message || String(error),
      })
      return true
    }
  }

  // POST /api/tts/batch — 批量文本语音合成（时序演播预加载）
  if (req.method === 'POST' && path === '/batch') {
    try {
      const body = await readJsonBody(req)
      const items = Array.isArray(body.items) ? body.items : []
      const referenceId = body.referenceId || DEFAULT_REFERENCE_ID
      const model = body.model || DEFAULT_MODEL

      const results = []
      for (const item of items) {
        const text = typeof item === 'string' ? item : item.text || item.speech
        const id = item.id !== undefined ? item.id : results.length + 1
        if (!text) continue
        try {
          const resItem = await synthesizeSpeech({ text, referenceId, model })
          results.push({ id, text, ok: true, ...resItem })
        } catch (e) {
          results.push({ id, text, ok: false, error: e.message || String(e) })
        }
      }

      sendJson(res, 200, { ok: true, items: results })
      return true
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message || String(error) })
      return true
    }
  }

  return false
}

export function fishAudioPlugin() {
  return {
    name: 'fish-audio-proxy',
    configureServer(server) {
      ensureAudioCacheDir()
      server.middlewares.use('/api/tts', (req, res, next) => {
        Promise.resolve(handleFishAudioRequest(req, res))
          .then((handled) => {
            if (!handled) next()
          })
          .catch(next)
      })
    },
  }
}
