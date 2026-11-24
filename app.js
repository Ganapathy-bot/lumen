import * as ort from "./vendor/ort.min.js";

const INPUT = 128;
const PAD = 24;
const TILE = INPUT - PAD * 2;
const SCALE = 4;

const statusEl = document.querySelector("#status");
const statusText = document.querySelector("#status-text");
const fileInput = document.querySelector("#file");
const drop = document.querySelector("#drop");
const dropTitle = document.querySelector("#drop-title");
const dropMeta = document.querySelector("#drop-meta");
const edge = document.querySelector("#edge");
const edgeValue = document.querySelector("#edge-value");
const run = document.querySelector("#run");
const save = document.querySelector("#save");
const sampleBtn = document.querySelector("#sample");
const alertEl = document.querySelector("#alert");
const empty = document.querySelector("#empty");
const preview = document.querySelector("#preview");
const sourceView = document.querySelector("#source-view");
const compare = document.querySelector("#compare");
const before = document.querySelector("#before");
const after = document.querySelector("#after");
const clip = document.querySelector("#clip");
const split = document.querySelector("#split-range");
const progress = document.querySelector("#progress");
const progressBar = document.querySelector("#progress-bar");
const progressLabel = document.querySelector("#progress-label");
const figIn = document.querySelector("#fig-in");
const figOut = document.querySelector("#fig-out");
const figTime = document.querySelector("#fig-time");
const where = document.querySelector("#where");

let sourceFile = null;
let sourceUrl = null;
let resultUrl = null;
let resultName = "frame-x4.png";
let busy = false;
let weightsReady = false;
let session = null;
let modelBytes = null;
let provider = "wasm";

ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = {
  mjs: new URL("./vendor/ort-wasm-simd-threaded.jsep.js", import.meta.url),
  wasm: new URL("./vendor/ort-wasm-simd-threaded.jsep.wasm", import.meta.url),
};

function setStatus(kind, text) {
  statusEl.className = `status ${kind}`;
  statusText.textContent = text;
}

function showAlert(message) {
  if (!message) {
    alertEl.hidden = true;
    alertEl.textContent = "";
    return;
  }
  alertEl.hidden = false;
  alertEl.textContent = message;
}

function formatBytes(bytes) {
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function setProgress(ratio, label) {
  progress.hidden = false;
  progressBar.style.width = `${Math.max(4, Math.min(100, ratio * 100))}%`;
  progressLabel.textContent = label;
}

function setSplit(value) {
  const ratio = Number(value) / 1000;
  clip.style.width = `${ratio * 100}%`;
  const full = compare.getBoundingClientRect().width;
  before.style.width = `${full}px`;
}

function rememberFile(file) {
  if (!file) return;
  if (!/^image\/(png|jpeg|webp)$/.test(file.type) && !/\.(png|jpe?g|webp)$/i.test(file.name)) {
    showAlert("Use a PNG, JPEG, or WebP frame.");
    return;
  }
  sourceFile = file;
  if (sourceUrl) URL.revokeObjectURL(sourceUrl);
  sourceUrl = URL.createObjectURL(file);
  dropTitle.textContent = file.name;
  dropMeta.textContent = formatBytes(file.size);
  showAlert("");
  showSource();
  run.disabled = busy || !weightsReady;
  save.hidden = true;
  figIn.textContent = "—";
  figOut.textContent = "—";
  figTime.textContent = "—";
}

function showSource() {
  empty.hidden = true;
  compare.hidden = true;
  preview.hidden = false;
  sourceView.src = sourceUrl;
}

function fitSize(width, height, longEdge) {
  const longest = Math.max(width, height);
  if (longest <= longEdge) return [width, height];
  const scale = longEdge / longest;
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

async function workingPixels(file, longEdge) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const [width, height] = fitSize(bitmap.width, bitmap.height, longEdge);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return context.getImageData(0, 0, width, height);
}

function tilePlan(width, height) {
  if (width <= INPUT && height <= INPUT) {
    return [{ x0: 0, y0: 0, x1: width, y1: height, padX: 0, padY: 0 }];
  }
  const tiles = [];
  const tilesX = Math.ceil(width / TILE);
  const tilesY = Math.ceil(height / TILE);
  for (let y = 0; y < tilesY; y += 1) {
    for (let x = 0; x < tilesX; x += 1) {
      const x0 = x * TILE;
      const y0 = y * TILE;
      tiles.push({
        x0,
        y0,
        x1: Math.min(x0 + TILE, width),
        y1: Math.min(y0 + TILE, height),
        padX: Math.max(x0 - PAD, 0),
        padY: Math.max(y0 - PAD, 0),
      });
    }
  }
  return tiles;
}

function fillTile(pixels, width, height, padX, padY) {
  const data = new Float32Array(3 * INPUT * INPUT);
  const plane = INPUT * INPUT;
  for (let y = 0; y < INPUT; y += 1) {
    const sourceY = Math.min(height - 1, Math.max(0, padY + y));
    for (let x = 0; x < INPUT; x += 1) {
      const sourceX = Math.min(width - 1, Math.max(0, padX + x));
      const source = (sourceY * width + sourceX) * 4;
      const dest = y * INPUT + x;
      data[dest] = pixels[source] / 255;
      data[plane + dest] = pixels[source + 1] / 255;
      data[plane * 2 + dest] = pixels[source + 2] / 255;
    }
  }
  return data;
}

function writeTile(target, targetWidth, output, outWidth, outHeight, tile) {
  const cropX = (tile.x0 - tile.padX) * SCALE;
  const cropY = (tile.y0 - tile.padY) * SCALE;
  const cropW = (tile.x1 - tile.x0) * SCALE;
  const cropH = (tile.y1 - tile.y0) * SCALE;
  const plane = outHeight * outWidth;
  const destX = tile.x0 * SCALE;
  const destY = tile.y0 * SCALE;
  for (let y = 0; y < cropH; y += 1) {
    const row = (destY + y) * targetWidth + destX;
    for (let x = 0; x < cropW; x += 1) {
      const source = (cropY + y) * outWidth + (cropX + x);
      const dest = (row + x) * 4;
      target[dest] = Math.max(0, Math.min(255, Math.round(output[source] * 255)));
      target[dest + 1] = Math.max(0, Math.min(255, Math.round(output[plane + source] * 255)));
      target[dest + 2] = Math.max(0, Math.min(255, Math.round(output[plane * 2 + source] * 255)));
      target[dest + 3] = 255;
    }
  }
}

async function reconstruct(image) {
  const tiles = tilePlan(image.width, image.height);
  const canvas = document.createElement("canvas");
  canvas.width = image.width * SCALE;
  canvas.height = image.height * SCALE;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const frame = context.createImageData(canvas.width, canvas.height);
  for (let index = 0; index < tiles.length; index += 1) {
    const tile = tiles[index];
    const input = new ort.Tensor("float32", fillTile(image.data, image.width, image.height, tile.padX, tile.padY), [1, 3, INPUT, INPUT]);
    const result = await session.run({ input });
    const output = result.output;
    const outWidth = output.dims[3];
    const outHeight = output.dims[2];
    const pixels = await output.getData(true);
    writeTile(frame.data, canvas.width, pixels, outWidth, outHeight, tile);
    const done = index + 1;
    setProgress(done / tiles.length, tiles.length === 1 ? "Reconstructing" : `Tile ${done} of ${tiles.length}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  context.putImageData(frame, 0, 0);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("The reconstruction could not be encoded.");
  return { blob, width: canvas.width, height: canvas.height };
}

async function openSession(bytes) {
  const base = { graphOptimizationLevel: "all" };
  if (navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        const gpu = await ort.InferenceSession.create(bytes, { ...base, executionProviders: ["webgpu"] });
        return { gpu, where: "This browser, GPU" };
      }
    } catch (error) {
      console.warn(error);
    }
  }
  const gpu = await ort.InferenceSession.create(bytes, { ...base, executionProviders: ["wasm"] });
  return { gpu, where: "This browser, CPU" };
}

async function loadWeights() {
  setStatus("busy", "Fetching weights");
  setProgress(0.04, "Fetching weights");
  try {
    const response = await fetch(new URL("./model.onnx", import.meta.url));
    if (!response.ok) throw new Error("The weights could not be downloaded.");
    const total = Number(response.headers.get("content-length")) || 0;
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      const ratio = total ? received / total : 0.5;
      const label = total ? `Fetching weights · ${Math.round(ratio * 100)}%` : "Fetching weights";
      setStatus("busy", label);
      setProgress(ratio, label);
    }
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    setStatus("busy", "Preparing the network");
    setProgress(1, "Preparing the network");
    modelBytes = bytes;
    const opened = await openSession(bytes);
    session = opened.gpu;
    provider = opened.where.endsWith("GPU") ? "webgpu" : "wasm";
    where.textContent = opened.where;
    weightsReady = true;
    progress.hidden = true;
    setStatus("ready", opened.where === "This browser, GPU" ? "Ready · GPU" : "Ready · CPU");
    run.disabled = busy || !sourceFile;
  } catch (error) {
    weightsReady = false;
    progress.hidden = true;
    setStatus("error", "Weights did not load");
    showAlert(error.message || "The network could not be prepared in this browser.");
  }
}

split.addEventListener("input", () => setSplit(split.value));
window.addEventListener("resize", () => {
  if (!compare.hidden) setSplit(split.value);
});

edge.addEventListener("input", () => {
  edgeValue.textContent = `${edge.value} px`;
});

fileInput.addEventListener("change", () => rememberFile(fileInput.files[0]));

["dragenter", "dragover"].forEach((name) => {
  drop.addEventListener(name, (event) => {
    event.preventDefault();
    drop.classList.add("over");
  });
});
["dragleave", "drop"].forEach((name) => {
  drop.addEventListener(name, (event) => {
    event.preventDefault();
    drop.classList.remove("over");
  });
});
drop.addEventListener("drop", (event) => {
  rememberFile(event.dataTransfer.files[0]);
});

const table = document.querySelector("#table");
["dragenter", "dragover"].forEach((name) => {
  table.addEventListener(name, (event) => event.preventDefault());
});
table.addEventListener("drop", (event) => {
  event.preventDefault();
  rememberFile(event.dataTransfer.files[0]);
});

sampleBtn.addEventListener("click", async () => {
  showAlert("");
  sampleBtn.disabled = true;
  try {
    const response = await fetch(new URL("./sample.jpg", import.meta.url));
    if (!response.ok) throw new Error("The sample frame is missing.");
    const blob = await response.blob();
    rememberFile(new File([blob], "sample-watch.jpg", { type: "image/jpeg" }));
  } catch (error) {
    showAlert(error.message);
  } finally {
    sampleBtn.disabled = false;
  }
});

run.addEventListener("click", async () => {
  if (!sourceFile || busy || !weightsReady) return;
  busy = true;
  run.disabled = true;
  save.hidden = true;
  showAlert("");
  showSource();
  setProgress(0.04, "Reading the frame");
  setStatus("busy", "Reconstructing");
  const started = performance.now();
  try {
    const image = await workingPixels(sourceFile, Number(edge.value));
    figIn.textContent = `${image.width} × ${image.height}`;
    figOut.textContent = `${image.width * SCALE} × ${image.height * SCALE}`;
    figTime.textContent = "Running";
    const stem = (sourceFile.name || "frame").replace(/\.[^.]+$/, "") || "frame";
    resultName = `${stem}-x4.png`;
    let result;
    try {
      result = await reconstruct(image);
    } catch (error) {
      if (provider !== "webgpu") throw error;
      setProgress(0.04, "Continuing on CPU");
      session = await ort.InferenceSession.create(modelBytes, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
      });
      provider = "wasm";
      where.textContent = "This browser, CPU";
      result = await reconstruct(image);
    }
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    resultUrl = URL.createObjectURL(result.blob);
    preview.hidden = true;
    compare.hidden = false;
    progress.hidden = true;
    before.src = sourceUrl;
    after.src = resultUrl;
    after.onload = () => setSplit(split.value);
    save.hidden = false;
    figTime.textContent = `${((performance.now() - started) / 1000).toFixed(1)} s`;
    setStatus("ready", "Print ready");
  } catch (error) {
    progress.hidden = true;
    showAlert(error.message || "The reconstruction stopped.");
    setStatus("ready", weightsReady ? "Ready" : "Weights did not load");
  } finally {
    busy = false;
    run.disabled = !sourceFile || !weightsReady;
  }
});

save.addEventListener("click", () => {
  if (!resultUrl) return;
  const link = document.createElement("a");
  link.href = resultUrl;
  link.download = resultName;
  link.click();
});

loadWeights();
