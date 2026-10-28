import { useEffect, useRef } from "react";
import topology from "../assets/countries-110m.json";

export interface EraTheme {
  phosphor: string;
  dim: string;
  label: string;
}

// Four real mainline era presets (1953-default/1979-default/1991-default/
// 2019-default, see packages/content/src/packs/index.ts). These restrained
// print colors distinguish eras without turning the launcher into a terminal.
const ERA_THEMES: Record<string, EraTheme> = {
  "1953": { phosphor: "#173f69", dim: "23,63,105", label: "World map · 1953" },
  "1979": { phosphor: "#9a6030", dim: "154,96,48", label: "World map · 1979" },
  "1991": { phosphor: "#526b7d", dim: "82,107,125", label: "World map · 1991" },
  "1999": { phosphor: "#2f6f6a", dim: "47,111,106", label: "World map · 1999" },
  "2007": { phosphor: "#7a5a1e", dim: "122,90,30", label: "World map · 2007" },
  "2019": { phosphor: "#8e2942", dim: "142,41,66", label: "World map · 2019" },
  "2023": { phosphor: "#5a3a8a", dim: "90,58,138", label: "World map · 2023" },
  "2027": { phosphor: "#365f75", dim: "54,95,117", label: "World map · 2027" },
};

const DEFAULT_THEME: EraTheme = ERA_THEMES["1953"]!;

export function themeForEra(eraId: string): EraTheme {
  return ERA_THEMES[eraId] ?? { ...DEFAULT_THEME, label: `World map · ${eraId}` };
}

const CAPITALS: readonly { name: string; lat: number; lon: number }[] = [
  { name: "WASHINGTON", lat: 38.9, lon: -77.0 },
  { name: "LONDON", lat: 51.5, lon: -0.1 },
  { name: "MOSCOW", lat: 55.7, lon: 37.6 },
];

const DEG = Math.PI / 180;

type TopologyArc = number[][];
type CountryGeometry = { type: "Polygon" | "MultiPolygon"; arcs: number[][] | number[][][] };
type CountryTopology = { arcs: TopologyArc[]; objects: { countries: { geometries: CountryGeometry[] } }; transform: { scale: [number, number]; translate: [number, number] } };

function buildLandRings(source: CountryTopology): readonly (readonly [number, number][])[] {
  const [sx, sy] = source.transform.scale;
  const [tx, ty] = source.transform.translate;
  const decoded = source.arcs.map((arc) => {
    let x = 0;
    let y = 0;
    return arc.map(([dx, dy]) => {
      x += dx!;
      y += dy!;
      return [x * sx + tx, y * sy + ty] as [number, number];
    });
  });
  const ring = (indices: readonly number[]) => indices.flatMap((index) => {
    // TopoJSON encodes reversed arcs as bitwise complements, not negatives.
    const arc = decoded[index >= 0 ? index : ~index] ?? [];
    return index >= 0 ? arc : [...arc].reverse();
  });
  return source.objects.countries.geometries.flatMap((geometry) => {
    const polygons = geometry.type === "Polygon" ? [geometry.arcs as number[][]] : geometry.arcs as number[][][];
    return polygons.map((polygon) => ring(polygon[0] ?? []));
  });
}

const LAND_RINGS = buildLandRings(topology as unknown as CountryTopology);

type ProjectedPoint = { x: number; y: number; z: number };

interface Props {
  eraId: string;
  live?: boolean;
}

export function globeBackingSize(cssPixels: number, devicePixelRatio: number): number {
  return Math.max(1, Math.round(cssPixels * Math.min(Math.max(devicePixelRatio, 1), 3)));
}

export function CommandGlobe({ eraId, live = false }: Props): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const eraRef = useRef<EraTheme>(themeForEra(eraId));
  eraRef.current = themeForEra(eraId);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reduceMotion = mql.matches || document.documentElement.dataset.animations === "off";

    let S = 0;
    let R = 0;
    let dpr = 1;
    let raf = 0;
    let rot = 0;
    let last = performance.now();
    let hidden = document.hidden;

    function resize(): void {
      dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), 3);
      S = Math.max(canvas!.clientWidth, canvas!.getBoundingClientRect().width);
      canvas!.width = globeBackingSize(S, dpr);
      canvas!.height = globeBackingSize(S, dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      R = S * 0.47;
    }

    function drawFrame(): void {
      const cx = S / 2;
      const cy = S / 2;
      const era = eraRef.current;
      ctx!.clearRect(0, 0, S, S);

      ctx!.save();
      ctx!.beginPath();
      ctx!.arc(cx, cy, R, 0, Math.PI * 2);
      ctx!.clip();
      // Match the website's ocean lighting and restrained neutral country fill.
      const ocean = ctx!.createRadialGradient(cx - R * 0.24, cy - R * 0.3, 0, cx, cy, R);
      ocean.addColorStop(0, "#a8d8ea");
      ocean.addColorStop(0.18, "#3d9bd4");
      ocean.addColorStop(0.45, "#1a6b9f");
      ocean.addColorStop(0.72, "#0d4876");
      ocean.addColorStop(1, "#071d3a");
      ctx!.fillStyle = ocean;
      ctx!.fillRect(0, 0, S, S);

      const project = (longitude: number, latitude: number): ProjectedPoint => {
        const lon = longitude * DEG + rot;
        const lat = latitude * DEG;
        const cosLat = Math.cos(lat);
        const x3 = cosLat * Math.sin(lon);
        const y3 = Math.sin(lat);
        return { x: cx + R * x3, y: cy - R * y3, z: cosLat * Math.cos(lon) };
      };

      const horizonPoint = (
        from: readonly [number, number],
        to: readonly [number, number],
        fromZ: number,
      ): ProjectedPoint => {
        let lo = 0;
        let hi = 1;
        // A short binary search gives a stable, smooth intersection at the
        // sphere rim even when a country edge crosses it between vertices.
        for (let i = 0; i < 8; i += 1) {
          const t = (lo + hi) / 2;
          const point = project(from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t);
          if ((fromZ >= 0) === (point.z >= 0)) lo = t;
          else hi = t;
        }
        const t = (lo + hi) / 2;
        return project(from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t);
      };

      for (const land of LAND_RINGS) {
        if (land.length < 2) continue;
        ctx!.beginPath();
        let previous = land[land.length - 1]!;
        let previousPoint = project(previous[0], previous[1]);
        let started = false;
        for (const current of land) {
          const currentPoint = project(current[0], current[1]);
          const previousVisible = previousPoint.z >= 0;
          const currentVisible = currentPoint.z >= 0;
          if (currentVisible !== previousVisible) {
            const edge = horizonPoint(previous, current, previousPoint.z);
            if (currentVisible) ctx!.moveTo(edge.x, edge.y);
            else ctx!.lineTo(edge.x, edge.y);
            started = currentVisible;
          }
          if (currentVisible) {
            if (!started) ctx!.moveTo(currentPoint.x, currentPoint.y);
            else ctx!.lineTo(currentPoint.x, currentPoint.y);
            started = true;
          } else {
            started = false;
          }
          previous = current;
          previousPoint = currentPoint;
        }
        ctx!.fillStyle = "#474e5a";
        ctx!.globalAlpha = 0.9;
        ctx!.fill();
        ctx!.globalAlpha = 0.38;
        ctx!.strokeStyle = "rgba(180,197,210,0.65)";
        ctx!.lineWidth = 0.7;
        ctx!.stroke();
      }
      ctx!.globalAlpha = 1;

      ctx!.font = "600 9px ui-sans-serif, system-ui, sans-serif";
      for (const c of CAPITALS) {
        const lon = c.lon * DEG + rot;
        const lat = c.lat * DEG;
        const cosLat = Math.cos(lat);
        const x3 = cosLat * Math.sin(lon);
        const y3 = Math.sin(lat);
        const z3 = cosLat * Math.cos(lon);
        if (z3 < 0.25) continue;
        const x = cx + R * x3;
        const y = cy - R * y3;
        ctx!.fillStyle = era.phosphor;
        ctx!.globalAlpha = Math.min(1, z3 + 0.2);
        ctx!.beginPath();
        ctx!.arc(x, y, 2.2, 0, Math.PI * 2);
        ctx!.fill();
        ctx!.fillStyle = "rgba(230,239,245,0.82)";
        ctx!.fillText(c.name, x + 7, y + 3);
        ctx!.globalAlpha = 1;
      }

      const vg = ctx!.createRadialGradient(cx - R * 0.25, cy - R * 0.28, R * 0.2, cx, cy, R * 1.08);
      vg.addColorStop(0, "rgba(255,255,255,0.05)");
      vg.addColorStop(0.62, "rgba(0,0,0,0.08)");
      vg.addColorStop(1, "rgba(0,0,0,0.52)");
      ctx!.fillStyle = vg;
      ctx!.fillRect(0, 0, S, S);

      ctx!.strokeStyle = `rgba(${era.dim},0.48)`;
      ctx!.lineWidth = 1.4;
      ctx!.beginPath();
      ctx!.arc(cx, cy, R, 0, Math.PI * 2);
      ctx!.stroke();
      ctx!.restore();
    }

    function frame(now: number): void {
      if (!reduceMotion && now - last < 1000 / 30) {
        raf = requestAnimationFrame(frame);
        return;
      }
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      if (!reduceMotion) rot += dt * 0.035;
      drawFrame();
      if (!reduceMotion && !hidden) {
        raf = requestAnimationFrame(frame);
      }
    }

    resize();
    drawFrame();
    if (!reduceMotion && !hidden) {
      raf = requestAnimationFrame(frame);
    }
    const handleResize = () => {
      resize();
      drawFrame();
    };
    window.addEventListener("resize", handleResize);
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(handleResize);
    resizeObserver?.observe(canvas);
    const onVisibilityChange = () => {
      hidden = document.hidden;
      if (hidden) cancelAnimationFrame(raf);
      else if (!reduceMotion) { last = performance.now(); raf = requestAnimationFrame(frame); }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    const onSettingsChange = () => {
      reduceMotion = mql.matches || document.documentElement.dataset.animations === "off";
      cancelAnimationFrame(raf);
      if (!reduceMotion && !hidden) { last = performance.now(); raf = requestAnimationFrame(frame); }
      else drawFrame();
    };
    document.addEventListener("ahdclient:settings", onSettingsChange);

    const onMotionChange = () => onSettingsChange();
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", onMotionChange);
    }

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", handleResize);
      resizeObserver?.disconnect();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      document.removeEventListener("ahdclient:settings", onSettingsChange);
      if (typeof mql.removeEventListener === "function") {
        mql.removeEventListener("change", onMotionChange);
      }
    };
  }, []);

  const theme = themeForEra(eraId);

  return (
    <div className="launcher-globe-wrap">
      <canvas ref={canvasRef} aria-hidden="true" />
      <div className="launcher-globe-chip">
        {live ? (
          <>
            <span className="launcher-globe-dot live" aria-hidden="true" />
            Online world
          </>
        ) : (
          <>
            <span
              className="launcher-globe-dot"
              style={{ background: theme.phosphor }}
              aria-hidden="true"
            />
            {theme.label}
          </>
        )}
      </div>
    </div>
  );
}
