import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const PORT = process.env.PORT ? Number(process.env.PORT) : 8123
const HOST = '127.0.0.1'
const URL = `http://127.0.0.1:${PORT}`
const MODELS_DIR = process.env.MODELS_DIR || path.join(__dirname, 'models')
const MAX_BODY = 100 * 1024 * 1024

const DEFAULT_MODEL = 'llava-qwen2-7b-32k-instruct-q5_K_M.gguf'
const DEFAULT_MMPROJ = 'mmproj-model-f16.gguf'

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('payload too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function send(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function resolveModelPath(req) {
  const m = req.headers['x-model'] || DEFAULT_MODEL
  const p = path.join(MODELS_DIR, m)
  if (fs.existsSync(p)) return p
  const dir = path.join(MODELS_DIR, path.basename(path.dirname(m)))
  if (fs.existsSync(path.join(dir, m))) return path.join(dir, m)
  return p
}

async function resolveMmprojPath(req) {
  const m = req.headers['x-mmproj'] || DEFAULT_MMPROJ
  const p = path.join(MODELS_DIR, m)
  if (fs.existsSync(p)) return p
  return p
}

function pickMmproj(modelFile, modelDir, mmprojFile, mmprojDir) {
  if (mmprojFile && fs.existsSync(mmprojFile)) return mmprojFile
  if (mmprojDir && fs.existsSync(mmprojDir)) return mmprojDir
  const local = path.join(path.dirname(modelFile), 'mmproj-model-f16.gguf')
  if (fs.existsSync(local)) return local
  return null
}

async function waitForLlama(baseUrl, timeoutMs = 180000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(baseUrl + '/health')
      if (r.ok) return true
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw new Error('llama-server did not become ready in time')
}

function spawnLlama({ port, model, mmproj, ngl, ctx }) {
  const bin = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
  const args = [
    '-m', model,
    '--port', String(port),
    '--host', '127.0.0.1',
    '--ctx-size', String(ctx || 8192),
    '-ngl', String(ngl || 99),
  ]
  if (mmproj) args.push('--mmproj', mmproj)
  console.log(`[caption] spawning: ${bin} ${args.join(' ')}`)
  const proc = spawn(bin, args, { stdio: 'inherit' })
  proc.on('error', (e) => console.error('[caption] llama-server spawn error:', e.message))
  return proc
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Model, X-Mmproj',
      })
      return res.end()
    }

    if (req.method === 'GET' && req.url === '/health') {
      return send(res, 200, { ok: true, url: URL })
    }

    if (req.method === 'GET' && req.url === '/api/server-info') {
      return send(res, 200, { url: URL, port: PORT })
    }

    if (req.method === 'POST' && req.url === '/api/caption') {
      const buf = await readBody(req)
      let body
      try { body = JSON.parse(buf.toString('utf8')) } catch (e) {
        return send(res, 400, { ok: false, error: 'invalid JSON body' })
      }
      const { image_base64, instructions, temperature } = body
      if (!image_base64) return send(res, 400, { ok: false, error: 'missing image_base64' })

      const modelPath = await resolveModelPath(req)
      const mmprojPath = await resolveMmprojPath(req)
      if (!fs.existsSync(modelPath)) {
        return send(res, 404, { ok: false, error: `model not found: ${path.basename(modelPath)}` })
      }

      const llamaPort = 8901 + Math.floor(Math.random() * 900)
      const mm = pickMmproj(modelPath, MODELS_DIR, mmprojPath, MODELS_DIR)
      const proc = spawnLlama({ port: Number(llamaPort), model: modelPath, mmproj: mm, ngl: 99, ctx: 8192 })
      const llamaUrl = `http://127.0.0.1:${llamaPort}`

      try {
        await waitForLlama(llamaUrl)
      } catch (e) {
        try { proc.kill() } catch (_) {}
        return send(res, 500, { ok: false, error: e.message })
      }

      const systemPrompt = (instructions || '').trim() ||
        'You are an expert image captioner for fine-tuning Ideogram 4. Produce a faithful, dense, structured caption of the image. Return JSON only, no prose, matching exactly: {"high_level_description","style_description":{"aesthetics","lighting","medium","photo"|"art_style","color_palette":["#rrggbb"]},"compositional_deconstruction":{"background","elements":[{"type":"obj"|"text","desc","text","bbox":[ymin,xmin,ymax,xmax],"color_palette":[]}]}}. bbox is on a 0-1000 scale.'

      const payload = {
        model: path.basename(modelPath),
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Return the caption JSON for this image now.' },
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image_base64}` } },
            ],
          },
        ],
        max_tokens: 2048,
        temperature: temperature ?? 0.2,
        response_format: { type: 'json_object' },
      }

      let captionText = ''
      try {
        const r = await fetch(llamaUrl + '/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        if (!r.ok) throw new Error(`llama-server ${r.status}: ${(await r.text()).slice(0, 400)}`)
        const j = await r.json()
        captionText = j.choices?.[0]?.message?.content || ''
      } finally {
        try { proc.kill() } catch (_) {}
      }

      let data = null
      try {
        const cleaned = captionText.replace(/```json/gi, '').replace(/```/g, '').trim()
        const s = cleaned.indexOf('{'), e = cleaned.lastIndexOf('}')
        data = JSON.parse(s >= 0 && e > s ? cleaned.slice(s, e + 1) : cleaned)
      } catch (e) {
        return send(res, 200, { ok: true, raw: captionText, data: null, error: 'could not parse JSON: ' + e.message })
      }

      return send(res, 200, { ok: true, data })
    }

    return send(res, 404, { ok: false, error: 'not found' })
  } catch (e) {
    return send(res, 500, { ok: false, error: e.message })
  }
})

server.listen(PORT, HOST, () => {
  console.log(`[caption] Ideogram4 caption server listening on ${URL}`)
  const info = { url: URL, port: PORT, models_dir: MODELS_DIR, default_model: DEFAULT_MODEL, default_mmproj: DEFAULT_MMPROJ }
  fs.writeFile(path.join(__dirname, 'server-info.json'), JSON.stringify(info, null, 2), () => {})
})
