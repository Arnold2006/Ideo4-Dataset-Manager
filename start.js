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
          event: "/http:\\/\\/[\\w.]+:[0-9]+/",
          done: true
        }]
      }
    },
    {
      method: "local.set",
      params: {
        url: "{{input.event[0]}}"
      }
    },
    {
      method: "browser.open",
      params: {
        uri: "{{local.url}}",
        target: "_blank"
      }
    }
  ]
}
