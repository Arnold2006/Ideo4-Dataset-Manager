import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const modelsDir = path.join(__dirname, 'models')
// GGUF conversion of https://huggingface.co/fancyfeast/llama-joycaption-beta-one-hf-llava
// (the fancyfeast repo is safetensors-only — no GGUF/mmproj — so this is the
// same model in llama.cpp format). mmproj pairs with the SigLIP2 vision tower;
// do NOT mix it with another model's mmproj.
// Quality ladder in the same repo: Q4_K (default, ~5GB) < Q8_0 (~8.5GB) < F16 (~16GB).
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
