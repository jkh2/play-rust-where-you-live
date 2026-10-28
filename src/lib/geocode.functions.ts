import { createServerFn } from "@tanstack/react-start";

export type PlaceHit = {
  label: string;
  name: string;
  lat: number;
  lon: number;
  south: number;
  north: number;
  west: number;
  east: number;
  point: boolean;
};

function asQuery(input: unknown) {
  if (!input || typeof input !== "object") throw new Error("Type a place");
  const q = (input as { q?: unknown }).q;
  if (typeof q !== "string") throw new Error("Type a place");
  const trimmed = q.trim().slice(0, 140);
  if (trimmed.length < 2) throw new Error("Type a place");
  return trimmed;
}

export const searchPlaces = createServerFn({ method: "POST" })
  .validator(asQuery)
  .handler(async ({ data }): Promise<PlaceHit[]> => {
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("q", data);
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("limit", "6");
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "PlayWhereYouLive/1.0 (https://github.com/jkh2/play-rust-where-you-live)",
      },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error("The place search did not answer");
    const rows = (await res.json()) as {
      display_name?: string;
      name?: string;
      lat?: string;
      lon?: string;
      boundingbox?: string[];
      type?: string;
      addresstype?: string;
    }[];
    return rows
      .map((row) => {
        const bb = row.boundingbox;
        if (!bb || bb.length < 4 || row.lat == null || row.lon == null) return null;
        const south = Number(bb[0]);
        const north = Number(bb[1]);
        const west = Number(bb[2]);
        const east = Number(bb[3]);
        if (![south, north, west, east].every(Number.isFinite)) return null;
        const kind = `${row.type ?? ""} ${row.addresstype ?? ""}`;
        const tiny = north - south < 0.03 && east - west < 0.03;
        const point = tiny || /house|building|amenity|highway|address/.test(kind);
        const name = row.name?.trim() || row.display_name?.split(",")[0]?.trim() || data;
        return {
          label: row.display_name ?? name,
          name,
          lat: Number(row.lat),
          lon: Number(row.lon),
          south,
          north,
          west,
          east,
          point,
        };
      })
      .filter((row): row is PlaceHit => row !== null);
  });
