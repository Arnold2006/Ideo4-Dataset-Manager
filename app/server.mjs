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
  const quants = files
    .filter(f => f.toLowerCase().endsWith('.gguf') && !f.toLowerCase().includes('mmproj'))
  // Prefer the highest-quality quant if several are present
  // (Q8_0 > Q4_K > F16), otherwise fall back to sorted order.
  const rank = (f) => {
    const n = f.toLowerCase()
    if (n.includes('q8_0')) return 0
    if (n.includes('q4_k')) return 1
    if (n.includes('f16')) return 2
    return 3
  }
  quants.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  const modelFile = quants[0]
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
  const steering = (instructions || '').trim()
  const sysPrompt = steering
    ? SYSTEM_PROMPT + '\n\nCRITICAL — User steering instructions (MUST follow exactly, takes precedence over defaults; applies to ALL fields, not just style):\n' + steering
    : SYSTEM_PROMPT
  const styleNote = '\n\nYou MUST always include the "style_description" object with ALL fields, in order: aesthetics, lighting, medium, photo, art_style, color_palette. Give every field a rich, specific value — never an empty string. "medium" is "photograph" for photos, otherwise the broad type (illustration, painting, 3d_render, …). Fill in BOTH "photo" (camera/lens details) and "art_style" (technique, texture); the pipeline keeps the one matching "medium".'
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
      // JoyCaption-style descriptive lead (cf. Jay_Caption_Beta_one_Batch_WebUI
      // default prompt "Write a long detailed description for this image."),
      // blended with the JSON-only requirement our pipeline needs.
      text: (steering
        ? `Write a long detailed description for this image. You MUST obey these user instructions exactly: ${steering} Respond with ONLY the Ideogram 4 JSON caption object for it — a single JSON object and nothing else.`
        : 'Write a long detailed description for this image. Respond with ONLY the Ideogram 4 JSON caption object for it — a single JSON object and nothing else.') + errorSuffix
    }
  ]

  messages.push({ role: 'user', content: userContent })
  return messages
}

function extractHldPrefix(instructions) {
  const s = (instructions || '').trim()
  if (!s) return null
  const patterns = [
    /add\s+the\s+word\s+["'“”]([^"'“”]+)["'“”]\s+as\s+(?:a\s+)?prefix\s+(?:to\s+)?high_level_description/i,
    /prefix\s+high_level_description\s+with\s+(?:the\s+word\s+)?["'“”]([^"'“”]+)["'“”]/i,
    /prefix\s+["'“”]([^"'“”]+)["'“”]\s+to\s+high_level_description/i,
  ]
  for (const re of patterns) {
    const m = s.match(re)
    if (m && m[1].trim()) return m[1]
  }
  return null
}

// Deterministic enforcement: small local models under a strict JSON grammar
// routinely ignore abstract "prefix X" instructions in the prompt. Since the
// prefix is mechanical, apply it here so it can never be silently dropped.
function applySteeringPostProcess(caption, instructions) {
  const prefix = extractHldPrefix(instructions)
  if (!prefix) return { applied: false }
  const cur = caption.high_level_description || ''
  const normCur = cur.trimStart().toLowerCase()
  const normPre = prefix.trim().toLowerCase()
  const core = normPre.replace(/[\s.]+$/, '')
  if (normCur.startsWith(normPre) || (core && normCur.startsWith(core + ' ') ) || (core && normCur === core)) {
    return { applied: false, prefix, reason: 'already present' }
  }
  let p = prefix
  if (!/\s$/.test(p)) p += ' '
  caption.high_level_description = p + cur.trimStart()
  return { applied: true, prefix }
}

// Second-read guard against hallucinated on-image text: small VLMs often emit
// "text" elements where no legible text exists. After a caption validates, ask
// the (already loaded) model to transcribe all clearly legible text and drop
// any text element it cannot confirm. Fail-open: if transcription fails, the
// caption is kept as-is.
const TEXT_VERIFY_SCHEMA = {
  type: 'object',
  required: ['texts'],
  properties: { texts: { type: 'array', items: { type: 'string' } } },
}

function normTranscribed(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim()
}

function isTextConfirmed(elemText, transcribed) {
  const e = normTranscribed(elemText)
  if (!e) return false
  return transcribed.some((t) => {
    const n = normTranscribed(t)
    if (!n) return false
    if (n === e) return true
    // Substring either way, but only for non-trivial strings so a single
    // letter can't match everything.
    if (Math.min(n.length, e.length) >= 3 && (n.includes(e) || e.includes(n))) return true
    return false
  })
}

async function verifyTextElements(llamaUrl, imageBase64, caption) {
  const elements = caption?.compositional_deconstruction?.elements || []
  if (!elements.some((el) => el.type === 'text' && el.text)) return { checked: false }
  const base64Data = imageBase64.replace(/^data:[^;]+;base64,/, '')
  const messages = [
    { role: 'system', content: 'You transcribe text visible in images. Reply with ONLY JSON, nothing else.' },
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Data}` } },
        { type: 'text', text: 'Transcribe every piece of clearly legible text visible in this image, each as a separate string. If no legible text is visible, return an empty array. Reply with ONLY JSON of the form {"texts": [...]}, nothing else.' },
      ],
    },
  ]
  let raw = null
  try {
    const res = await fetch(llamaUrl + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'local',
        messages,
        temperature: 0.2,
        max_tokens: 512,
        stream: false,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'text_transcription', schema: TEXT_VERIFY_SCHEMA, strict: true }
        }
      })
    })
    if (!res.ok) throw new Error(`llama-server error ${res.status}`)
    const j = await res.json()
    const content = j.choices?.[0]?.message?.content || ''
    try { raw = JSON.parse(content) }
    catch {
      const s = content.indexOf('{'), e = content.lastIndexOf('}')
      if (s >= 0 && e > s) raw = JSON.parse(content.slice(s, e + 1))
    }
  } catch (err) {
    console.log('[caption] text verification skipped:', String(err?.message || err).slice(0, 200))
    return { checked: false }
  }
  const transcribed = raw && Array.isArray(raw.texts) ? raw.texts.filter((t) => typeof t === 'string') : null
  if (!transcribed) return { checked: false }
  const before = elements.length
  caption.compositional_deconstruction.elements = elements.filter((el) => {
    if (el.type !== 'text' || !el.text) return true
    const ok = isTextConfirmed(el.text, transcribed)
    if (!ok) console.log('[caption] dropping unconfirmed text element:', JSON.stringify(el.text))
    return ok
  })
  return { checked: true, dropped: before - caption.compositional_deconstruction.elements.length }
}

async function callLlamaServer(llamaUrl, messages, temperature, topP) {
  const res = await fetch(llamaUrl + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'local',
      messages,
      temperature,
      top_p: topP,
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
      // Sampling tuned to the reference JoyCaption WebUI
      // (temperature 0.6, top_p 0.9; calmer retry on regeneration).
      text = await callLlamaServer(llamaUrl, messages, attempt === 1 ? 0.6 : 0.3, 0.9)
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

    const steeringResult = applySteeringPostProcess(normalized.value, instructions)
    if (steeringResult.applied) {
      console.log('[caption] steering prefix enforced:', JSON.stringify(steeringResult.prefix))
    }

    const verifyResult = await verifyTextElements(llamaUrl, imageBase64, normalized.value)
    if (verifyResult.checked && verifyResult.dropped > 0) {
      console.log(`[caption] text verification dropped ${verifyResult.dropped} unconfirmed text element(s)`)
    }

    // Final gate: re-validate after post-processing (prefixing + text drops).
    // A caption left with zero elements fails here and is regenerated with
    // feedback telling the model to stop inventing text.
    const recheck = validateCaption(normalized.value)
    if (!recheck.valid) {
      lastErrors = [...recheck.errors, 'create "text" elements ONLY for clearly legible on-image text; describe blurry/unreadable signs as "obj" elements instead']
      continue
    }

    return {
      ok: true,
      data: normalized.value,
      prompt_compact: serializeCaption(normalized.value),
      valid: true,
      attempts: attempt,
      steering_applied: steeringResult.applied || false,
      version: 'DEBUG_20260903_v3'
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
      console.log('[caption] steering:', JSON.stringify((instructions || '').trim().slice(0, 300)))

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
        return send(res, 200, { ok: true, data: result.data, prompt_compact: result.prompt_compact, valid: true, attempts: result.attempts, steering_applied: result.steering_applied || false })
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
