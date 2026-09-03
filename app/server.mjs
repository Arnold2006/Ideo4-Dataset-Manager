import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { GENERATION_SCHEMA } from './src/generation-schema.mjs'
import { normalizeCaption, serializeCaption } from './src/normalize.mjs'
import { validateCaption } from './src/validate.mjs'
import { SYSTEM_PROMPT } from './src/prompt.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const PORT = process.env.PORT ? Number(process.env.PORT) : 8123
const HOST = '127.0.0.1'
const URL = `http://127.0.0.1:${PORT}`
const MODELS_DIR = process.env.MODELS_DIR || path.join(__dirname, 'models')
const MAX_BODY = 100 * 1024 * 1024
const MAX_ATTEMPTS = 3

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
    .filter(f => f.toLowerCase().endsWith('.gguf') && !f.toLowerCase().includes('mmproj'))
    .sort()[0]
  if (!modelFile) throw new Error('No model .gguf found in app/models/')
  const mmprojFile = files.find(f => f.toLowerCase().includes('mmproj') && f.toLowerCase().endsWith('.gguf'))
  return { modelFile: path.join(MODELS_DIR, modelFile), mmprojFile: mmprojFile ? path.join(MODELS_DIR, mmprojFile) : null }
}

function resolveLlamaServer() {
  const candidates = [
    path.join(__dirname, '..', 'bin', 'llama-server.exe'),
    path.join(__dirname, '..', 'bin', 'llama-server'),
    path.join(__dirname, 'bin', 'llama-server.exe'),
    path.join(__dirname, 'bin', 'llama-server'),
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  throw new Error('llama-server binary not found in bin/. Run the install script to download it.')
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
  const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  proc.stderr.on('data', (d) => { const s = d.toString().trim(); if (s) console.error('[llama]', s) })
  proc.on('error', (e) => console.error('[caption] llama-server spawn error:', e.message))
  return proc
}

function buildMessages(imageBase64, instructions, lastErrors) {
  const sysPrompt = (instructions || '').trim()
    ? SYSTEM_PROMPT + '\n\nAdditional style guidance:\n' + instructions.trim()
    : SYSTEM_PROMPT
  const styleNote = '\n\nYou MUST always include the "style_description" object in your output. It is required, never optional. Choose either the photograph variant (with fields: aesthetics, lighting, photo, medium="photograph", color_palette) or the art variant (with fields: aesthetics, lighting, medium, art_style, color_palette). Always populate all fields with rich, specific values. Never omit style_description.'
  const messages = [{ role: 'system', content: sysPrompt + styleNote }]

  const errorSuffix = lastErrors.length > 0
    ? '\n\n(Your previous answer had these problems, fix them: ' + lastErrors.join('; ') + ')'
    : ''

  const base64Data = imageBase64.replace(/^data:[^;]+;base64,/, '')
  const userContent = [
    {
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${base64Data}` }
    },
    {
      type: 'text',
      text: (instructions
        ? `Analyse this image and use it as the subject. Additional context from user: ${instructions}`
        : 'Analyse this image carefully and generate a detailed Ideogram 4 JSON prompt for it.') + errorSuffix
    }
  ]

  messages.push({ role: 'user', content: userContent })
  return messages
}

async function callLlamaServer(llamaUrl, messages, temperature) {
  const res = await fetch(llamaUrl + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'local',
      messages,
      temperature,
      max_tokens: 4096,
      stream: false,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'ideogram_prompt', schema: GENERATION_SCHEMA, strict: true }
      }
    })
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`llama-server error ${res.status}: ${err.slice(0, 400)}`)
  }

  const j = await res.json()
  return j.choices?.[0]?.message?.content || ''
}

async function generateCaption(llamaUrl, imageBase64, instructions) {
  let lastErrors = []

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const messages = buildMessages(imageBase64, instructions, lastErrors)

    let text
    try {
      text = await callLlamaServer(llamaUrl, messages, attempt === 1 ? 0.7 : 0.3)
    } catch (err) {
      return { ok: false, error: String(err?.message || err) }
    }

    let raw
    try { raw = JSON.parse(text) }
    catch {
      let cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim()
      try {
        raw = JSON.parse(cleaned)
      } catch {
        const s = cleaned.indexOf('{'), e = cleaned.lastIndexOf('}')
        if (s >= 0 && e > s) {
          try { raw = JSON.parse(cleaned.slice(s, e + 1)) } catch { lastErrors = ['output was not parseable JSON']; continue }
        } else { lastErrors = ['output was not parseable JSON']; continue }
      }
    }

    console.log('[caption] Raw AI response style_description:', JSON.stringify(raw.style_description))
    const normalized = normalizeCaption(raw)
    console.log('[caption] Normalized result ok:', normalized.ok, 'style:', JSON.stringify(normalized.value?.style_description))
    if (!normalized.ok) { lastErrors = [normalized.reason]; continue }

    const { valid, errors } = validateCaption(normalized.value)
    if (!valid) { lastErrors = errors; continue }

    return {
      ok: true,
      data: normalized.value,
      prompt_compact: serializeCaption(normalized.value),
      valid: true,
      attempts: attempt,
      version: 'DEBUG_20260903_v2'
    }
  }

  return {
    ok: false,
    error: `Could not produce a valid caption after ${MAX_ATTEMPTS} attempts.`,
    errors: lastErrors
  }
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
      const htmlPath = path.join(__dirname, '..', 'index.html')
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

      const result = await generateCaption(llamaUrl, image_base64, instructions)

      try { proc.kill() } catch (_) {}

      if (result.ok) {
        return send(res, 200, { ok: true, data: result.data, prompt_compact: result.prompt_compact, valid: true, attempts: result.attempts })
      }
      return send(res, 200, { ok: false, error: result.error, errors: result.errors })
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
