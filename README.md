# Ideogram 4 Dataset Editor

A local, single-window editor for building **Ideogram 4** fine-tuning datasets, with **AI image
captioning** (single image or whole batch) powered by a local **llama.cpp** vision model.

- Open a folder of images; paired `.json` caption files are loaded when present.
- Edit the structured caption (overview, style, composition, elements + bounding boxes).
- **AI Caption** the current image, or **Caption all** to batch the whole dataset.
- Captions are **auto-saved** to the paired `.json` (downloaded for images that don't have one).
- Runs as a **Pinokio** app: one click to install, start, update, and reset.

## How it works

```
project-root/
├── app/
│   ├── server.mjs          # Node HTTP server: serves the editor + /api/caption (spawns llama-server)
│   ├── package.json
│   ├── models/             # GGUF model + mmproj (downloaded by install.js)  [gitignored]
│   └── server-info.json    # written at runtime                               [gitignored]
├── ideogram4_dataset_editor_v4_FORCED_DARK.html   # the UI (served by the server)
├── install.js              # conda llama.cpp + model download
├── start.js                # launches the server on a free port, writes server-info.json
├── reset.js                # removes model weights + runtime files
├── update.js               # refreshes llama.cpp + model
├── pinokio.js              # launcher UI
├── pinokio.json            # metadata
└── server-info.json        # { "url": "http://127.0.0.1:PORT" } written by start.js [gitignored]
```

The server is a zero-dependency Node process. For each caption request it spawns
`llama-server -m <model> --mmproj <mmproj>`, calls the OpenAI-compatible
`/v1/chat/completions` endpoint with the base64 image, parses the JSON the model
returns into the dataset schema, and tears the subprocess down.

## Install & run (Pinokio)

1. **Install** — installs `llama-cpp-cuda` (conda) and downloads the vision model + mmproj.
2. **Start** — launches the editor on a free port and writes `server-info.json`.
3. **Open Editor** — opens the web UI in your browser.

> The editor auto-detects the server: when opened at `http://127.0.0.1:PORT/`, it uses that
> origin for AI calls. If you open the HTML file directly, put the server URL in the
> **Caption server** bar (or click **Auto-detect**).

## Using the editor

- **Choose folder** — pick the dataset folder (images + optional `.json`).
- **AI caption** — captions the current image and saves it.
- **Caption all** — captions every image in the folder (progress shown in the top bar).
- **Save / Save all** — manual save of the structured caption.
- Drag bounding boxes on the image, or edit the `0–1000` values in each element card.

## API

The server exposes an OpenAI-compatible endpoint plus a convenience endpoint.

### `POST /api/caption`

Request:
```json
{ "image_base64": "<base64 jpeg/png>", "instructions": "optional extra guidance" }
```
Headers (optional): `X-Model` (model filename), `X-Mmproj` (mmproj filename).

Response `200`:
```json
{ "ok": true, "data": { "high_level_description": "...", "style_description": { ... }, "compositional_deconstruction": { ... } } }
```

On error: `{ "ok": false, "error": "..." }`.

### `GET /api/server-info`
```json
{ "url": "http://127.0.0.1:8123", "port": 8123 }
```

### `GET /health`
```json
{ "ok": true, "url": "http://127.0.0.1:8123" }
```

### `GET /v1/chat/completions`
Standard llama.cpp OpenAI-compatible chat completions (the raw model backend).

## Curl examples

```bash
# health
curl http://127.0.0.1:8123/health

# caption an image (base64 in a file)
curl -s http://127.0.0.1:8123/api/caption \
  -H 'Content-Type: application/json' \
  -d "{\"image_base64\":\"$(base64 -w0 cat.png)\"}"
```

## Python example

```python
import base64, json, urllib.request

with open("cat.png", "rb") as f:
    payload = {"image_base64": base64.b64encode(f.read()).decode()}
req = urllib.request.Request(
    "http://127.0.0.1:8123/api/caption",
    data=json.dumps(payload).encode(),
    headers={"Content-Type": "application/json"},
)
print(json.load(urllib.request.urlopen(req))["data"])
```

## JavaScript example

```javascript
const b64 = await (await fetch('cat.png').then(r => r.blob()))
  .then(f => f.arrayBuffer())
  .then(ab => btoa(String.fromCharCode.apply(null, new Uint8Array(ab))));
const r = await fetch('http://127.0.0.1:8123/api/caption', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ image_base64: b64 }),
});
console.log((await r.json()).data);
```

## Configuration

| Env var      | Default                          | Purpose                              |
|--------------|----------------------------------|--------------------------------------|
| `PORT`       | `8123` (or Pinokio `{{port}}`)   | Port the HTTP server listens on       |
| `MODELS_DIR` | `app/models`                     | Where the GGUF model + mmproj live    |

The default model is `llava-qwen2-7b-32k-instruct-q5_K_M.gguf` with `mmproj-model-f16.gguf`.
Place any other GGUF vision model + matching mmproj in `app/models` and pass the filename via
the `X-Model` / `X-Mmproj` headers.
