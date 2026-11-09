"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-fetch server data periodically while the tab is visible, so the other party's actions appear. */
export function AutoRefresh({ everyMs = 4000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible" && !document.querySelector("[data-busy='true']")) router.refresh();
    }, everyMs);
    return () => clearInterval(id);
  }, [router, everyMs]);
  return null;
}
