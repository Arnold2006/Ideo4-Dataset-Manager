module.exports = {
  daemon: true,
  run: [
    {
      method: "shell.run",
      params: {
        env: {
          PORT: "{{port}}"
        },
        path: "app",
        message: [
          "node server.mjs"
        ],
        on: [{
          event: "/(http:\\/\\/127\\.0\\.0\\.1:[0-9]+|http:\\/\\/localhost:[0-9]+)/",
          done: true
        }]
      }
    },
    {
      method: "local.set",
      params: {
        url: "{{input.event[1]}}"
      }
    },
    {
      method: "system.open",
      params: {
        url: "{{input.event[1]}}"
      }
    }
  ]
}
