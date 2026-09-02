module.exports = {
  requires: {
    bundle: "ai"
  },
  run: [
    {
      method: "shell.run",
      params: {
        message: [
          "conda install -y -c conda-forge llama-cpp-cuda"
        ]
      }
    },
    {
      method: "shell.run",
      params: {
        message: [
          "npm i --no-audit --no-fund --quiet --omit=dev"
        ],
        path: "app"
      }
    },
    {
      method: "hf.download",
      params: {
        path: "app",
        "_": [
          "bartowski/Meta-Llama-3.2-11B-Vision-Instruct-GGUF"
        ],
        "include": ["llava-qwen2-7b-32k-instruct-q5_K_M.gguf", "mmproj-model-f16.gguf"],
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
