module.exports = async (kernel) => {
  const PORT = await kernel.port()
  return {
    daemon: true,
    run: [
      {
        method: "shell.run",
        params: {
          path: "app",
          env: {
            PORT: String(PORT)
          },
          message: [
            "node server.mjs"
          ],
          on: [{
            "event": "/(http:\\/\\/127\\.0\\.0\\.1:[0-9]+|http:\\/\\/localhost:[0-9]+)/",
            "done": true
          }]
        }
      },
      {
        method: "fs.write",
        params: {
          path: "server-info.json",
          "json": {
            "url": "{{input.event[1]}}"
          }
        }
      },
      {
        method: "local.set",
        params: {
          "url": "{{input.event[1]}}"
        }
      }
    ]
  }
}
