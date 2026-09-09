import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const modelsDir = path.join(__dirname, 'models')
// Huihui Qwen3-VL-8B-Instruct (abliterated/uncensored) GGUF + matching mmproj.
// mmproj is vision-tower-specific: do NOT mix it with another model's mmproj.
// Quality ladder in the same repo: Q4_K_M (default, ~5GB) < Q5_K_M < Q6_K < Q8_0.
const MODEL_FILE = 'Huihui-Qwen3-VL-8B-Instruct-abliterated-Q4_K_M.gguf'
const MMPROJ_FILE = 'mmproj-F16.gguf'
// Stale files from the previous JoyCaption model — keeping them wastes ~6GB
// and risks the server pairing the wrong mmproj, so remove them on switch.
const STALE_FILES = [
  'Llama-Joycaption-Beta-One-Hf-Llava-Q4_K.gguf',
  'llama-joycaption-beta-one-llava-mmproj-model-f16.gguf',
]
if (fs.existsSync(modelsDir)) {
  const present = fs.readdirSync(modelsDir)
  if (present.includes(MODEL_FILE) && present.includes(MMPROJ_FILE)) {
    console.log('model already present, skipping download')
    process.exit(0)
  }
  for (const stale of STALE_FILES) {
    const p = path.join(modelsDir, stale)
    if (fs.existsSync(p)) {
      fs.rmSync(p)
      console.log('removed stale model file:', stale)
    }
  }
}
const { download } = await import('@huggingface/hub')
const REPO = 'noctrex/Huihui-Qwen3-VL-8B-Instruct-abliterated-GGUF'
await download(REPO, MODEL_FILE, { localDir: 'models' })
await download(REPO, MMPROJ_FILE, { localDir: 'models' })
console.log('model download complete')
