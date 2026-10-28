import { compressBlock, compressBound } from "lz4js";

const FIELD = 1 << 0;
const SUMMIT = 1 << 2;
const BEACHSIDE = 1 << 3;
const BEACH = 1 << 4;
const FOREST = 1 << 5;
const OCEAN = 1 << 7;
const DECOR = 1 << 9;
const RIVER = 1 << 14;
const RIVERSIDE = 1 << 15;
const CLIFFSIDE = 1 << 22;
const MOUNTAIN = 1 << 23;
const TIER0 = 1 << 26;
const TIER1 = 1 << 27;
const TIER2 = 1 << 28;
const MAINLAND = 1 << 29;

export function nextPow2(value: number) {
  if (value <= 1) return 1;
  return 2 ** Math.ceil(Math.log2(value));
}

export function resolutions(worldSize: number) {
  const half = Math.floor(worldSize * 0.5);
  const texture = nextPow2(half);
  return { texture, mesh: texture + 1 };
}

export function gridNote(worldSize: number) {
  const { mesh } = resolutions(worldSize);
  if (mesh >= 4097) return "Heavy file. The height grid jumps to 4097. A computer handles this better than a phone.";
  if (mesh <= 1025) return "Smaller file. The ridges keep less detail.";
  return "Standard server size.";
}

function percentile(values: Float32Array, p: number) {
  const step = Math.max(1, Math.floor(values.length / 80_000));
  const sample: number[] = [];
  for (let i = 0; i < values.length; i += step) sample.push(values[i]);
  sample.sort((a, b) => a - b);
  const index = Math.min(sample.length - 1, Math.max(0, Math.round(p * (sample.length - 1))));
  return sample[index];
}

function oceanMask(raw: Float32Array, n: number) {
  const sea = new Uint8Array(raw.length);
  const stack: number[] = [];
  const push = (i: number) => {
    if (sea[i] || raw[i] > 1) return;
    sea[i] = 1;
    stack.push(i);
  };
  for (let x = 0; x < n; x++) {
    push(x);
    push((n - 1) * n + x);
  }
  for (let y = 0; y < n; y++) {
    push(y * n);
    push(y * n + (n - 1));
  }
  while (stack.length) {
    const i = stack.pop() as number;
    const x = i % n;
    const y = (i / n) | 0;
    if (x > 0) push(i - 1);
    if (x < n - 1) push(i + 1);
    if (y > 0) push(i - n);
    if (y < n - 1) push(i + n);
  }
  return sea;
}

function southUp(northUp: Float32Array, n: number) {
  const dst = new Float32Array(northUp.length);
  for (let y = 0; y < n; y++) {
    dst.set(northUp.subarray((n - 1 - y) * n, (n - y) * n), y * n);
  }
  return dst;
}

function flow(raw: Float32Array, n: number) {
  let minI = 0;
  for (let i = 1; i < raw.length; i++) if (raw[i] < raw[minI]) minI = i;
  const outletX = minI % n;
  const outletY = (minI / n) | 0;
  const down = new Int32Array(raw.length);
  down.fill(-1);
  const neighbors = [
    [-1, -1],
    [0, -1],
    [1, -1],
    [-1, 0],
    [1, 0],
    [-1, 1],
    [0, 1],
    [1, 1],
  ];
  const dist = (x: number, y: number) => (x - outletX) ** 2 + (y - outletY) ** 2;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      if (i === minI) continue;
      const here = dist(x, y);
      let best = -1;
      let bestScore = Infinity;
      let fallback = -1;
      let fallbackDist = Infinity;
      for (const [dx, dy] of neighbors) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= n || yy >= n) continue;
        const away = dist(xx, yy);
        if (away < fallbackDist) {
          fallbackDist = away;
          fallback = yy * n + xx;
        }
        if (away >= here && raw[yy * n + xx] >= raw[i]) continue;
        const score = raw[yy * n + xx] * 10_000 + away;
        if (score < bestScore) {
          bestScore = score;
          best = yy * n + xx;
        }
      }
      down[i] = best >= 0 ? best : fallback;
    }
  }
  const incoming = new Int32Array(raw.length);
  for (let i = 0; i < down.length; i++) if (down[i] >= 0) incoming[down[i]]++;
  const queue: number[] = [];
  for (let i = 0; i < incoming.length; i++) if (incoming[i] === 0) queue.push(i);
  const accumulation = new Float32Array(raw.length);
  accumulation.fill(1);
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q];
    const next = down[i];
    if (next < 0) continue;
    accumulation[next] += accumulation[i];
    incoming[next]--;
    if (incoming[next] === 0) queue.push(next);
  }
  return accumulation;
}

function toShorts(norm: Float32Array) {
  const bytes = new Uint8Array(norm.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < norm.length; i++) {
    const clamped = Math.max(0, Math.min(1, norm[i]));
    view.setUint16(i * 2, Math.round(clamped * 65535), true);
  }
  return bytes;
}

function varint(value: number) {
  const bytes: number[] = [];
  let rest = value;
  while (rest >= 128) {
    bytes.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  bytes.push(rest);
  return Uint8Array.from(bytes);
}

function protoBytes(field: number, data: Uint8Array) {
  return [Uint8Array.from([(field << 3) | 2]), varint(data.length), data];
}

function protoString(field: number, value: string) {
  return protoBytes(field, new TextEncoder().encode(value));
}

function protoVarint(field: number, value: number) {
  return [Uint8Array.from([(field << 3) | 0]), varint(value)];
}

function concat(parts: Uint8Array[]) {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function mapMessage(name: string, data: Uint8Array) {
  const body = concat([...protoString(1, name), ...protoBytes(2, data)]);
  return concat(protoBytes(2, body));
}

const hashTable = new Uint32Array(65536);

function lz4Chunks(payload: Uint8Array) {
  const chunks: Uint8Array[] = [];
  const block = 1024 * 1024;
  for (let offset = 0; offset < payload.length; offset += block) {
    const src = payload.subarray(offset, Math.min(payload.length, offset + block));
    hashTable.fill(0);
    const bound = compressBound(src.length);
    const dst = new Uint8Array(bound);
    const written = compressBlock(src, dst, 0, src.length, hashTable);
    const compressed = written > 0 && written < src.length;
    const data = compressed ? dst.subarray(0, written) : src;
    const flags = compressed ? 1 : 0;
    const head = compressed
      ? concat([varint(flags), varint(src.length), varint(data.length)])
      : concat([varint(flags), varint(src.length)]);
    chunks.push(head, data);
  }
  return chunks;
}

export type BuiltMap = {
  blob: Blob;
  filename: string;
  bytes: number;
};

export async function buildRustMap(options: {
  worldSize: number;
  northUpMeters: Float32Array;
  place: string;
  onProgress?: (label: string) => void;
}): Promise<BuiltMap> {
  const { worldSize, onProgress } = options;
  const { mesh, texture } = resolutions(worldSize);
  if (options.northUpMeters.length !== mesh * mesh) throw new Error("Height grid does not match the world size");
  onProgress?.("Tracing the water");
  await yieldThread();
  const raw = southUp(options.northUpMeters, mesh);
  const sea = oceanMask(raw, mesh);
  const accumulation = flow(raw, mesh);
  let riverCut = 0;
  for (let i = 0; i < accumulation.length; i++) if (accumulation[i] > riverCut) riverCut = accumulation[i];
  riverCut = Math.max(mesh * 6, riverCut * 0.004);

  const low = percentile(raw, 0.04);
  const bench = percentile(raw, 0.42);
  const high = percentile(raw, 0.98);
  const norm = new Float32Array(raw.length);
  const river = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    if (sea[i]) {
      norm[i] = 0.4;
      continue;
    }
    const h = raw[i];
    if (h <= low) norm[i] = 0.48 + 0.04 * Math.max(0, (h - (low - 80)) / 80);
    else if (h <= bench) norm[i] = 0.54 + 0.1 * ((h - low) / Math.max(1, bench - low));
    else {
      const t = Math.max(0, Math.min(1, (h - bench) / Math.max(1, high - bench)));
      const smooth = t * t * (3 - 2 * t);
      norm[i] = 0.64 + 0.26 * smooth;
    }
    norm[i] = Math.max(0.42, Math.min(0.92, norm[i]));
    if (!sea[i] && accumulation[i] >= riverCut && norm[i] < 0.78) river[i] = 1;
  }

  const water = new Float32Array(norm);
  for (let i = 0; i < norm.length; i++) {
    if (sea[i]) water[i] = 0.5;
    else if (river[i]) water[i] = Math.min(0.96, norm[i] + 0.012);
    else water[i] = Math.max(0, norm[i] - 0.008);
  }

  onProgress?.("Painting the ground");
  await yieldThread();
  const cell = worldSize / (mesh - 1);
  const slopeAt = (i: number) => {
    const x = i % mesh;
    const y = (i / mesh) | 0;
    const h = norm[i];
    let steep = 0;
    const look = [
      [1, 0],
      [0, 1],
    ];
    for (const [dx, dy] of look) {
      const xx = Math.min(mesh - 1, x + dx);
      const yy = Math.min(mesh - 1, y + dy);
      const rise = Math.abs(norm[yy * mesh + xx] - h) * 1000;
      steep = Math.max(steep, rise / cell);
    }
    return steep;
  };

  const splat = new Uint8Array(texture * texture * 8);
  const biome = new Uint8Array(texture * texture * 4);
  const topology = new Uint8Array(texture * texture * 4);
  const topologyView = new DataView(topology.buffer);
  const alpha = new Uint8Array(texture * texture);
  alpha.fill(255);
  const texScale = (mesh - 1) / texture;

  const meshIndex = (x: number, y: number) => {
    const sx = Math.min(mesh - 1, Math.round(x * texScale));
    const sy = Math.min(mesh - 1, Math.round(y * texScale));
    return sy * mesh + sx;
  };

  for (let y = 0; y < texture; y++) {
    for (let x = 0; x < texture; x++) {
      const i = meshIndex(x, y);
      const h = norm[i];
      const steep = slopeAt(i);
      const wet = river[i] === 1 || sea[i] === 1;
      let arid = 0;
      let temperate = 0;
      let tundra = 0;
      let arctic = 0;
      if (h < 0.6) arid = 255;
      else if (h < 0.72) temperate = 255;
      else if (h < 0.82) tundra = 255;
      else arctic = 255;
      const area = texture * texture;
      const base = y * texture + x;
      biome[base] = arid;
      biome[area + base] = temperate;
      biome[area * 2 + base] = tundra;
      biome[area * 3 + base] = arctic;

      let dirt = 0;
      let snow = 0;
      let sand = 0;
      let rock = 0;
      let grass = 0;
      let forestFloor = 0;
      let stones = 0;
      if (sea[i] || wet) sand = 255;
      else if (h > 0.84) snow = 255;
      else if (steep > 0.55) rock = 220;
      else if (arid && steep < 0.2) {
        sand = 150;
        dirt = 105;
      } else if (temperate && steep < 0.35) {
        grass = 150;
        forestFloor = 70;
        dirt = 35;
      } else {
        dirt = 160;
        stones = 60;
        grass = 35;
      }
      const channels = [dirt, snow, sand, rock, grass, forestFloor, stones, 0];
      const sum = channels.reduce((a, c) => a + c, 0) || 1;
      let used = 0;
      for (let c = 0; c < 7; c++) {
        const value = Math.min(255 - used, Math.round((channels[c] / sum) * 255));
        splat[c * area + base] = value;
        used += value;
      }
      splat[7 * area + base] = 255 - used;

      let flags = sea[i] ? OCEAN : MAINLAND;
      const bank =
        !wet &&
        !sea[i] &&
        ((x > 0 && river[meshIndex(x - 1, y)]) ||
          (x + 1 < texture && river[meshIndex(x + 1, y)]) ||
          (y > 0 && river[meshIndex(x, y - 1)]) ||
          (y + 1 < texture && river[meshIndex(x, y + 1)]));
      if (river[i]) flags |= RIVER | RIVERSIDE;
      if (bank && h < 0.7) flags |= BEACH | BEACHSIDE | RIVERSIDE | TIER0;
      if (sea[i]) flags |= OCEAN;
      else if (!wet && h < 0.58 && steep < 0.25) flags |= FIELD | TIER0;
      else if (!wet && h < 0.74 && steep < 0.4) flags |= FOREST | DECOR | TIER1;
      if (steep > 0.55) flags |= CLIFFSIDE | MOUNTAIN | DECOR;
      if (h > 0.8) flags |= MOUNTAIN | SUMMIT | TIER2;
      topologyView.setInt32((y * texture + x) * 4, flags, true);
    }
    if (y % 256 === 0) await yieldThread();
  }

  onProgress?.("Writing the map file");
  await yieldThread();
  const terrain = toShorts(norm);
  const waterBytes = toShorts(water);
  const parts = [
    ...protoVarint(1, worldSize),
    mapMessage("terrain", terrain),
    mapMessage("height", terrain),
    mapMessage("water", waterBytes),
    mapMessage("splat", splat),
    mapMessage("biome", biome),
    mapMessage("topology", topology),
    mapMessage("alpha", alpha),
  ];
  const payload = concat(parts);
  const header = new Uint8Array(12);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, 10, true);
  headerView.setBigInt64(4, BigInt(Date.now()), true);
  const packed = [header, ...lz4Chunks(payload)].map((part) => part as BlobPart);
  const blob = new Blob(packed, { type: "application/octet-stream" });
  const slug = options.place
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "")
    .slice(0, 28) || "Place";
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return {
    blob,
    filename: `${slug}-${worldSize}-${stamp}.map`,
    bytes: blob.size,
  };
}

function yieldThread() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}
