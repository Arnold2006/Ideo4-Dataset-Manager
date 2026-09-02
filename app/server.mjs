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

function resolveModels() {
  if (!fs.existsSync(MODELS_DIR)) {
    throw new Error('No models/ directory. Run the install script first.')
  }
  const files = fs.readdirSync(MODELS_DIR)
  const modelFile = files
    .filter(f => f.toLowerCase().endsWith('.gguf') && !f.toLowerCase().startsWith('mmproj'))
    .sort()[0]
  if (!modelFile) throw new Error('No model .gguf found in app/models/')
  const mmprojFile = files.find(f => f.toLowerCase().startsWith('mmproj') && f.toLowerCase().endsWith('.gguf'))
  return { modelFile: path.join(MODELS_DIR, modelFile), mmprojFile: mmprojFile ? path.join(MODELS_DIR, mmprojFile) : null }
}

function resolveLlamaServer() {
  const candidates = [
    path.join(__dirname, 'bin', 'llama-server.exe'),
    path.join(__dirname, 'bin', 'llama-server'),
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  throw new Error('llama-server binary not found in app/bin/. Run the install script to download it.')
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

function spawnLlama({ bin, port, model, mmproj }) {
  const args = [
    '--model', model,
    '--ctx-size', '8192',
    '--port', String(port),
    '--host', '127.0.0.1',
    '--no-webui',
    '--jinja',
    '--n-gpu-layers', '99',
    '--parallel', '1',
    '--log-disable',
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
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      })
      return res.end()
    }

    if (req.method === 'GET' && req.url === '/health') {
      return send(res, 200, { ok: true, url: URL })
    }

    if (req.method === 'GET' && req.url === '/api/server-info') {
      return send(res, 200, { url: URL, port: PORT })
    }

    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      const htmlPath = path.join(__dirname, '..', 'ideogram4_dataset_editor_v4_FORCED_DARK.html')
      if (!fs.existsSync(htmlPath)) {
        return send(res, 404, { ok: false, error: 'editor HTML not found' })
      }
      const html = fs.readFileSync(htmlPath, 'utf8')
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(html),
        'Access-Control-Allow-Origin': '*',
      })
      return res.end(html)
    }

    if (req.method === 'POST' && req.url === '/api/caption') {
      const buf = await readBody(req)
      let body
      try { body = JSON.parse(buf.toString('utf8')) } catch (e) {
        return send(res, 400, { ok: false, error: 'invalid JSON body' })
      }
      const { image_base64, instructions } = body
      if (!image_base64) return send(res, 400, { ok: false, error: 'missing image_base64' })

      let modelPath, mmprojPath
      try {
        ({ modelFile: modelPath, mmprojFile: mmprojPath } = resolveModels())
      } catch (e) {
        return send(res, 404, { ok: false, error: e.message })
      }

      let llamaBin
      try { llamaBin = resolveLlamaServer() } catch (e) {
        return send(res, 500, { ok: false, error: e.message })
      }

      const llamaPort = 8901 + Math.floor(Math.random() * 900)
      const proc = spawnLlama({ bin: llamaBin, port: llamaPort, model: modelPath, mmproj: mmprojPath })
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
        temperature: 0.2,
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
  const info = { url: URL, port: PORT, models_dir: MODELS_DIR }
  fs.writeFile(path.join(__dirname, 'server-info.json'), JSON.stringify(info, null, 2), () => {})
})
