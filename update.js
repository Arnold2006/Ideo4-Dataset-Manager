module.exports = {
  run: [
    {
      method: "shell.run",
      params: {
        message: ["git pull"]
      }
    },
    {
      method: "shell.run",
      params: {
        path: "app",
        message: ["npm i --no-audit --no-fund --quiet --omit=dev"]
      }
    },
    {
      method: "shell.run",
      params: {
        path: "app",
        message: ["node download-llama.mjs"]
      }
    },
    {
      method: "hf.download",
      params: {
        path: "app",
        "_": ["noctrex/Huihui-Qwen3-VL-4B-Instruct-abliterated-GGUF", "Huihui-Qwen3-VL-4B-Instruct-abliterated-Q4_K_M.gguf"],
        "local-dir": "models"
      }
    },
    {
      method: "hf.download",
      params: {
        path: "app",
        "_": ["noctrex/Huihui-Qwen3-VL-4B-Instruct-abliterated-GGUF", "mmproj-F16.gguf"],
        "local-dir": "models"
      }
    }
  ]
}
