module.exports = {
  requires: {
    bundle: "ai"
  },
  run: [
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
        "_": ["concedo/llama-joycaption-beta-one-hf-llava-mmproj-gguf", "Llama-Joycaption-Beta-One-Hf-Llava-Q4_K.gguf"],
        "local-dir": "models"
      }
    },
    {
      method: "hf.download",
      params: {
        path: "app",
        "_": ["concedo/llama-joycaption-beta-one-hf-llava-mmproj-gguf", "llama-joycaption-beta-one-llava-mmproj-model-f16.gguf"],
        "local-dir": "models"
      }
    },
    {
      method: "notify",
      params: {
        html: "Install complete. Click <b>Start</b> to launch the editor."
      }
    }
  ]
}
