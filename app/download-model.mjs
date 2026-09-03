import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const modelsDir = path.join(__dirname, 'models')
const MODEL_FILE = 'Llama-Joycaption-Beta-One-Hf-Llava-Q4_K.gguf'
const MMPROJ_FILE = 'llama-joycaption-beta-one-llava-mmproj-model-f16.gguf'
if (fs.existsSync(modelsDir) && fs.readdirSync(modelsDir).includes(MODEL_FILE)) {
  console.log('model already present, skipping download')
  process.exit(0)
}
const { download } = await import('@huggingface/hub')
const REPO = 'concedo/llama-joycaption-beta-one-hf-llava-mmproj-gguf'
await download(REPO, MODEL_FILE, { localDir: 'models' })
await download(REPO, MMPROJ_FILE, { localDir: 'models' })
console.log('model download complete')
