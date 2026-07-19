/**
 * Measure a container's content width so charts can use a 1-unit-per-pixel
 * viewBox (no preserveAspectRatio="none" distortion of text / endpoint markers).
 * Falls back to a sensible default before the first measure and on SSR.
 */

import { useEffect, useRef, useState } from "react";

export function useChartWidth(fallback = 720): { ref: React.RefObject<HTMLDivElement | null>; width: number } {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(fallback);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width;
        if (w > 0) setWidth(Math.round(w));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return { ref, width };
}
