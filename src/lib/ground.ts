export type Bounds = {
  west: number;
  south: number;
  east: number;
  north: number;
};

const METERS = 111_320;

export function coverSquare(bounds: Bounds): Bounds {
  const lat = (bounds.south + bounds.north) / 2;
  const lonScale = METERS * Math.cos((lat * Math.PI) / 180);
  const height = (bounds.north - bounds.south) * METERS;
  const width = (bounds.east - bounds.west) * lonScale;
  const side = Math.max(height, width, 400);
  const latHalf = side / METERS / 2;
  const lonHalf = side / lonScale / 2;
  const cy = (bounds.south + bounds.north) / 2;
  const cx = (bounds.west + bounds.east) / 2;
  return { west: cx - lonHalf, east: cx + lonHalf, south: cy - latHalf, north: cy + latHalf };
}

export function milesBox(lat: number, lon: number, miles: number): Bounds {
  const side = miles * 1609.34;
  const latHalf = side / METERS / 2;
  const lonHalf = side / (METERS * Math.cos((lat * Math.PI) / 180)) / 2;
  return { west: lon - lonHalf, east: lon + lonHalf, south: lat - latHalf, north: lat + latHalf };
}

export function spanMiles(bounds: Bounds) {
  const lat = (bounds.south + bounds.north) / 2;
  const width = ((bounds.east - bounds.west) * METERS * Math.cos((lat * Math.PI) / 180)) / 1609.34;
  const height = ((bounds.north - bounds.south) * METERS) / 1609.34;
  return Math.max(width, height);
}

function lonToX(lon: number, zoom: number) {
  return ((lon + 180) / 360) * 2 ** zoom;
}

function latToY(lat: number, zoom: number) {
  const rad = (lat * Math.PI) / 180;
  const n = Math.log(Math.tan(rad) + 1 / Math.cos(rad));
  return ((1 - n / Math.PI) / 2) * 2 ** zoom;
}

function chooseZoom(bounds: Bounds, samples: number) {
  const lat = (bounds.south + bounds.north) / 2;
  const width = (bounds.east - bounds.west) * METERS * Math.cos((lat * Math.PI) / 180);
  for (let zoom = 12; zoom >= 5; zoom--) {
    const metersPerPixel = (40_075_016 * Math.cos((lat * Math.PI) / 180)) / (256 * 2 ** zoom);
    const pixels = width / metersPerPixel;
    const tiles = Math.ceil(pixels / 256) + 1;
    if (tiles * tiles <= 64 && pixels >= samples * 0.7) return zoom;
  }
  return 6;
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("A height tile failed"));
    image.src = src;
  });
}

/** Row 0 is north. Heights are meters. */
export async function sampleElevation(bounds: Bounds, samples: number, onProgress?: (label: string) => void) {
  const zoom = chooseZoom(bounds, samples);
  const west = lonToX(bounds.west, zoom);
  const east = lonToX(bounds.east, zoom);
  const north = latToY(bounds.north, zoom);
  const south = latToY(bounds.south, zoom);
  const x0 = Math.floor(west);
  const x1 = Math.floor(east);
  const y0 = Math.floor(north);
  const y1 = Math.floor(south);
  const jobs: { x: number; y: number }[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) jobs.push({ x, y });
  }
  onProgress?.(`Reading the ground, ${jobs.length} elevation tiles`);

  const canvas = document.createElement("canvas");
  canvas.width = samples;
  canvas.height = samples;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Could not read elevation");
  ctx.imageSmoothingEnabled = true;

  const spanX = east - west;
  const spanY = south - north;
  let done = 0;
  const batch = 6;
  for (let i = 0; i < jobs.length; i += batch) {
    const slice = jobs.slice(i, i + batch);
    const images = await Promise.all(
      slice.map((job) => loadImage(`/api/elev?z=${zoom}&x=${job.x}&y=${job.y}`)),
    );
    images.forEach((image, index) => {
      const job = slice[index];
      const dx = ((job.x - west) / spanX) * samples;
      const dy = ((job.y - north) / spanY) * samples;
      const dw = (1 / spanX) * samples;
      const dh = (1 / spanY) * samples;
      ctx.drawImage(image, dx, dy, dw + 1, dh + 1);
    });
    done += slice.length;
    onProgress?.(`Reading the ground, ${done} of ${jobs.length} tiles`);
  }

  const pixels = ctx.getImageData(0, 0, samples, samples).data;
  const heights = new Float32Array(samples * samples);
  for (let i = 0; i < heights.length; i++) {
    const r = pixels[i * 4];
    const g = pixels[i * 4 + 1];
    const b = pixels[i * 4 + 2];
    heights[i] = r * 256 + g + b / 256 - 32768;
  }
  return soften(heights, samples);
}

function soften(src: Float32Array, n: number) {
  const dst = new Float32Array(src.length);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let sum = 0;
      let count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
          sum += src[yy * n + xx];
          count++;
        }
      }
      dst[y * n + x] = sum / count;
    }
  }
  return dst;
}

export function drawHillshade(canvas: HTMLCanvasElement, heights: Float32Array, n: number) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  canvas.width = n;
  canvas.height = n;
  const image = ctx.createImageData(n, n);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < heights.length; i++) {
    if (heights[i] < min) min = heights[i];
    if (heights[i] > max) max = heights[i];
  }
  const span = Math.max(1, max - min);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const h = heights[y * n + x];
      const hx = heights[y * n + Math.min(n - 1, x + 1)] - h;
      const hy = heights[Math.min(n - 1, y + 1) * n + x] - h;
      const light = Math.max(0, Math.min(1, 0.55 + (-hx - hy) / (span * 0.18)));
      const t = (h - min) / span;
      const low = [92, 78, 52];
      const mid = [138, 124, 86];
      const high = [236, 230, 216];
      const stop = t < 0.55 ? low : t < 0.82 ? mid : high;
      const from = t < 0.55 ? low : t < 0.82 ? low : mid;
      const u = t < 0.55 ? t / 0.55 : t < 0.82 ? (t - 0.55) / 0.27 : (t - 0.82) / 0.18;
      const i = (y * n + x) * 4;
      image.data[i] = (from[0] + (stop[0] - from[0]) * u) * light;
      image.data[i + 1] = (from[1] + (stop[1] - from[1]) * u) * light;
      image.data[i + 2] = (from[2] + (stop[2] - from[2]) * u) * light;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
}
