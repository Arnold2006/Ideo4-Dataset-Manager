module.exports = {
  run: [
    {
      method: "shell.run",
      params: {
        message: [
          "conda update -y -c conda-forge llama-cpp-cuda"
        ]
      }
    },
    {
      method: "shell.run",
      params: {
        path: "app",
        message: [
          "npm i --no-audit --no-fund --quiet --omit=dev"
        ]
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
    }
  ]
}
