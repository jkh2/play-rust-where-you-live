import { useEffect, useRef } from "react";
import type { Bounds } from "@/lib/ground";

const BRASS = "#e0b15a";

type MapHandle = {
  fit: (bounds: Bounds) => void;
  setBox: (bounds: Bounds | null) => void;
};

function ring(bounds: Bounds) {
  const { west, south, east, north } = bounds;
  return {
    type: "Feature" as const,
    properties: {},
    geometry: {
      type: "Polygon" as const,
      coordinates: [
        [
          [west, south],
          [east, south],
          [east, north],
          [west, north],
          [west, south],
        ],
      ],
    },
  };
}

export function PlaceMap({
  bounds,
  onReady,
}: {
  bounds: Bounds | null;
  onReady?: (handle: MapHandle) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapHandle | null>(null);
  const boundsRef = useRef(bounds);
  boundsRef.current = bounds;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let dead = false;
    let map: import("maplibre-gl").Map | null = null;
    void (async () => {
      await import("maplibre-gl/dist/maplibre-gl.css");
      const maplibregl = await import("maplibre-gl");
      if (dead) return;
      maplibregl.setWorkerUrl(`${import.meta.env.BASE_URL}maplibre-gl-worker.mjs`);
      map = new maplibregl.Map({
        container: el,
        attributionControl: { compact: true },
        style: {
          version: 8,
          sources: {
            sat: {
              type: "raster",
              tiles: [
                "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
              ],
              tileSize: 256,
              attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
            },
          },
          layers: [{ id: "sat", type: "raster", source: "sat" }],
        },
        center: [-106.01, 37.15],
        zoom: 6,
      });
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "bottom-right");
      map.on("load", () => {
        if (!map) return;
        map.addSource("box", {
          type: "geojson",
          data: { type: "FeatureCollection", features: [] },
        });
        map.addLayer({
          id: "box-fill",
          type: "fill",
          source: "box",
          paint: { "fill-color": BRASS, "fill-opacity": 0.12 },
        });
        map.addLayer({
          id: "box-line",
          type: "line",
          source: "box",
          paint: { "line-color": BRASS, "line-width": 2 },
        });
        const handle: MapHandle = {
          setBox: (next) => {
            const source = map?.getSource("box");
            if (!source || source.type !== "geojson") return;
            const geo = source as import("maplibre-gl").GeoJSONSource;
            geo.setData(
              next
                ? { type: "FeatureCollection", features: [ring(next)] }
                : { type: "FeatureCollection", features: [] },
            );
          },
          fit: (next) => {
            map?.fitBounds(
              [
                [next.west, next.south],
                [next.east, next.north],
              ],
              { padding: 64, duration: 800, maxZoom: 13 },
            );
          },
        };
        mapRef.current = handle;
        onReady?.(handle);
        const initial = boundsRef.current;
        if (initial) {
          handle.setBox(initial);
          handle.fit(initial);
        }
      });
    })();
    return () => {
      dead = true;
      map?.remove();
    };
    // The map is created once. Later bounds go through the handle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const handle = mapRef.current;
    if (!handle) return;
    handle.setBox(bounds);
    if (bounds) handle.fit(bounds);
  }, [bounds]);

  return <div ref={host} className="absolute inset-0" />;
}
