# Ideo4 Dataset Manager

A local editor for building **Ideogram 4** fine-tuning datasets, with **AI image captioning** powered by a local llama.cpp vision model.

> ⚠️ Browser requirement: use a Chromium browser (**Chrome** or **Edge**).
> The editor needs the File System Access API to open the dataset folder and auto-save captions into it.
> - **Brave**: enable `brave://flags/#file-system-access-api`, then relaunch the browser.
> - **Firefox / Safari**: not supported — no folder access, no auto-save.

## Install & run (Pinokio)

1. **Install** — downloads prebuilt llama.cpp binaries and the vision model.
2. **Start** — launches the editor and writes `server-info.json`.
3. **Open Editor** — opens the web UI in your browser.

## Using the editor

- **Choose folder** — pick the dataset folder (images + optional `.json` captions).
- **AI caption** — captions the current image and saves it.
- **Caption all** — captions every uncaptioned image (progress in the top bar).
- **Save / Save all** — manual save of the structured caption.
- **Draw object / Draw text** — drag a bounding box directly on the image; drag existing boxes to move them, drag a corner to resize.

## Advanced

| Env var      | Default                        | Purpose                           |
|--------------|--------------------------------|-----------------------------------|
| `PORT`       | `8123` (or Pinokio `{{port}}`) | Port the HTTP server listens on   |
| `MODELS_DIR` | `app/models`                   | Where the GGUF model + mmproj live |

The default model is `Llama-Joycaption-Beta-One-Hf-Llava-Q4_K.gguf` with its matching mmproj
(downloaded from Hugging Face). Place any other GGUF vision model + matching mmproj in `app/models/`
and the server will auto-discover it.
