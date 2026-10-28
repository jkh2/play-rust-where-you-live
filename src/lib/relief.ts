/** Survey a height field from a RustMaps render. Water is read from color; inland rises from the coast. */

export type Relief = {
  resolution: number;
  heights: Float32Array;
};

function isWater(r: number, g: number, b: number) {
  return b > 58 && r < 50 && b > r + 22 && g > 36 && g < b + 18;
}

function isSnow(r: number, g: number, b: number) {
  return r > 210 && g > 210 && b > 200;
}

export function reliefFromImage(image: CanvasImageSource, sourceSize: number, resolution = 192): Relief {
  const canvas = document.createElement("canvas");
  canvas.width = resolution;
  canvas.height = resolution;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Could not read the map image");
  ctx.drawImage(image, 0, 0, resolution, resolution);
  const pixels = ctx.getImageData(0, 0, resolution, resolution).data;
  const n = resolution;
  const water = new Uint8Array(n * n);
  const luma = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) {
    const r = pixels[i * 4];
    const g = pixels[i * 4 + 1];
    const b = pixels[i * 4 + 2];
    water[i] = isWater(r, g, b) ? 1 : 0;
    luma[i] = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }

  const dist = new Float32Array(n * n);
  const INF = 1e6;
  for (let i = 0; i < dist.length; i++) dist[i] = water[i] ? 0 : INF;
  const relax = (i: number, j: number, step: number) => {
    if (j < 0 || j >= dist.length) return;
    const next = dist[j] + step;
    if (next < dist[i]) dist[i] = next;
  };
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      if (x > 0) relax(i, i - 1, 1);
      if (y > 0) relax(i, i - n, 1);
      if (x > 0 && y > 0) relax(i, i - n - 1, 1.4);
      if (x < n - 1 && y > 0) relax(i, i - n + 1, 1.4);
    }
  }
  for (let y = n - 1; y >= 0; y--) {
    for (let x = n - 1; x >= 0; x--) {
      const i = y * n + x;
      if (x < n - 1) relax(i, i + 1, 1);
      if (y < n - 1) relax(i, i + n, 1);
      if (x < n - 1 && y < n - 1) relax(i, i + n + 1, 1.4);
      if (x > 0 && y < n - 1) relax(i, i + n - 1, 1.4);
    }
  }

  const cap = n * 0.2;
  const heights = new Float32Array(n * n);
  for (let i = 0; i < heights.length; i++) {
    if (water[i]) {
      heights[i] = 0;
      continue;
    }
    const inland = Math.min(dist[i] / cap, 1);
    const shore = inland * inland * (3 - 2 * inland);
    const r = pixels[i * 4];
    const g = pixels[i * 4 + 1];
    const b = pixels[i * 4 + 2];
    const snow = isSnow(r, g, b) ? 0.22 : 0;
    const bright = Math.max(0, luma[i] - 0.35) * 0.18;
    heights[i] = 0.08 + shore * 0.72 + bright + snow;
  }

  const blur = (src: Float32Array) => {
    const dst = new Float32Array(src.length);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        let s = 0;
        let c = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
            s += src[yy * n + xx];
            c++;
          }
        }
        dst[y * n + x] = s / c;
      }
    }
    for (let i = 0; i < dst.length; i++) if (water[i]) dst[i] = 0;
    return dst;
  };

  let field = heights;
  for (let p = 0; p < 2; p++) field = blur(field);
  void sourceSize;
  return { resolution: n, heights: field };
}

export function sampleRelief(relief: Relief, size: number, x: number, z: number) {
  const n = relief.resolution;
  const u = (x / size + 0.5) * (n - 1);
  const v = (z / size + 0.5) * (n - 1);
  const x0 = Math.max(0, Math.min(n - 1, Math.floor(u)));
  const y0 = Math.max(0, Math.min(n - 1, Math.floor(v)));
  const x1 = Math.min(n - 1, x0 + 1);
  const y1 = Math.min(n - 1, y0 + 1);
  const tx = u - x0;
  const ty = v - y0;
  const h = relief.heights;
  const a = h[y0 * n + x0];
  const b = h[y0 * n + x1];
  const c = h[y1 * n + x0];
  const d = h[y1 * n + x1];
  return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
}
