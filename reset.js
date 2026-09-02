module.exports = {
  run: [
    {
      method: "fs.rm",
      params: {
        path: "app/models"
      }
    },
    {
      method: "fs.rm",
      params: {
        path: "app/server-info.json"
      }
    },
    {
      method: "fs.rm",
      params: {
        path: "server-info.json"
      }
    },
    {
      method: "notify",
      params: {
        html: "Reset complete. Click <b>Install</b> to re-download the model, then <b>Start</b>."
      }
    }
  ]
}
