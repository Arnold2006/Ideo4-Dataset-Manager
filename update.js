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
        message: [
          "if (Test-Path bin\\llama-server.exe) { Write-Host 'llama-server already present, skipping' } else { node download-llama.mjs }"
        ]
      }
    },
    {
      method: "shell.run",
      params: {
        path: "app",
        message: ["node download-model.mjs"]
      }
    }
  ]
}
