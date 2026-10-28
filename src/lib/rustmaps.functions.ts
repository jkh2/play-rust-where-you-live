import { createServerFn } from "@tanstack/react-start";

const API = "https://api.rustmaps.com/internal/v1";

export type RustMonument = {
  name: string;
  category: string;
  x: number;
  y: number;
};

export type RustMap = {
  id: string;
  seed: number;
  size: number;
  imageUrl: string;
  thumbnailUrl: string;
  landPercentage: number;
  biomes: { snow: number; desert: number; forest: number; tundra: number; jungle: number };
  monuments: RustMonument[];
  pageUrl: string;
};

export type RustHit = {
  mapId: string;
  seed: number;
  size: number;
  thumbnailUrl: string;
};

type Query = {
  size?: number;
  seed?: number;
  id?: string;
  sizeMin?: number;
  sizeMax?: number;
};

function asQuery(input: unknown): Query {
  if (!input || typeof input !== "object") throw new Error("Missing query");
  const o = input as Record<string, unknown>;
  const num = (k: string) => (o[k] == null || o[k] === "" ? undefined : Number(o[k]));
  return {
    size: num("size"),
    seed: num("seed"),
    id: typeof o.id === "string" ? o.id.trim() : undefined,
    sizeMin: num("sizeMin"),
    sizeMax: num("sizeMax"),
  };
}

function safeImage(url: unknown): string {
  if (typeof url !== "string" || !url) return "";
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.hostname !== "content.rustmaps.com") return "";
    return u.toString();
  } catch {
    return "";
  }
}

async function apiGet(path: string): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(12000),
  });
  const body = (await res.json().catch(() => null)) as {
    meta?: { errors?: string[]; status?: string };
    data?: unknown;
  } | null;
  if (!res.ok || !body || body.meta?.status === "Failed") {
    const msg = body?.meta?.errors?.[0] || `RustMaps returned ${res.status}`;
    throw new Error(msg);
  }
  return body.data;
}

function mapFromData(data: unknown): RustMap {
  const d = data as Record<string, unknown>;
  const biomes = (d.biomePercentages ?? {}) as Record<string, number>;
  const monuments = Array.isArray(d.monuments) ? d.monuments : [];
  const size = Number(d.size);
  const seed = Number(d.seed);
  const imageUrl = safeImage(d.imageUrl);
  if (!imageUrl || !Number.isFinite(size) || !Number.isFinite(seed)) {
    throw new Error("RustMaps response was missing the map image");
  }
  return {
    id: String(d.id ?? ""),
    seed,
    size,
    imageUrl,
    thumbnailUrl: safeImage(d.thumbnailUrl) || imageUrl,
    landPercentage: Number(d.landPercentageOfMap ?? 0),
    biomes: {
      snow: Number(biomes.s ?? 0),
      desert: Number(biomes.d ?? 0),
      forest: Number(biomes.f ?? 0),
      tundra: Number(biomes.t ?? 0),
      jungle: Number(biomes.j ?? 0),
    },
    monuments: monuments
      .map((raw) => {
        const m = raw as Record<string, unknown>;
        const c = (m.coordinates ?? {}) as Record<string, unknown>;
        const x = Number(c.x);
        const y = Number(c.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        return {
          name: String(m.type ?? "Monument"),
          category: String(m.sizeCategory ?? ""),
          x,
          y,
        };
      })
      .filter((m): m is RustMonument => m !== null),
    pageUrl: `https://rustmaps.com/map/${size}_${seed}`,
  };
}

export const fetchRustMap = createServerFn({ method: "POST" })
  .validator(asQuery)
  .handler(async ({ data }): Promise<RustMap> => {
    const id = data.id?.replace(/[^a-zA-Z0-9]/g, "");
    if (id && id.length >= 16 && (data.size == null || data.seed == null)) {
      return mapFromData(await apiGet(`/maps/${id}`));
    }
    const size = data.size;
    const seed = data.seed;
    if (!Number.isFinite(size) || !Number.isFinite(seed)) {
      throw new Error("Give a map link, or a size and a seed");
    }
    if (size! < 1000 || size! > 6000) throw new Error("Size must be between 1000 and 6000");
    return mapFromData(await apiGet(`/maps/${Math.round(size!)}/${Math.round(seed!)}`));
  });

export const searchRustMaps = createServerFn({ method: "POST" })
  .validator(asQuery)
  .handler(async ({ data }): Promise<RustHit[]> => {
    const sizeMin = Number.isFinite(data.sizeMin) ? data.sizeMin : 1000;
    const sizeMax = Number.isFinite(data.sizeMax) ? data.sizeMax : 6000;
    const res = await fetch(`${API}/maps/search`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ searchQuery: { size: { min: sizeMin, max: sizeMax } } }),
      signal: AbortSignal.timeout(12000),
    });
    const body = (await res.json().catch(() => null)) as {
      meta?: { errors?: string[]; status?: string };
      data?: unknown;
    } | null;
    if (!res.ok || !body || body.meta?.status === "Failed" || !Array.isArray(body.data)) {
      throw new Error(body?.meta?.errors?.[0] || "RustMaps search failed");
    }
    return body.data.slice(0, 12).map((raw) => {
      const h = raw as Record<string, unknown>;
      return {
        mapId: String(h.mapId ?? ""),
        seed: Number(h.seed),
        size: Number(h.size),
        thumbnailUrl: safeImage(h.thumbnailUrl),
      };
    });
  });
