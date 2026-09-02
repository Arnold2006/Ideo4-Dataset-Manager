import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const modelsDir = path.join(__dirname, 'models')
if (fs.existsSync(modelsDir) && fs.readdirSync(modelsDir).some(f => f.endsWith('.gguf'))) {
  console.log('models already present, skipping download')
  process.exit(0)
}
const { download } = await import('@huggingface/hub')
await download('noctrex/Huihui-Qwen3-VL-4B-Instruct-abliterated-GGUF', 'Huihui-Qwen3-VL-4B-Instruct-abliterated-Q4_K_M.gguf', { localDir: 'models' })
await download('noctrex/Huihui-Qwen3-VL-4B-Instruct-abliterated-GGUF', 'mmproj-F16.gguf', { localDir: 'models' })
console.log('model download complete')
