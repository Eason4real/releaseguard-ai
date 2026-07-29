"use client";

import { lazy, Suspense, useEffect, useState } from "react";
import PublicDemo from "./public-demo";
import type { DeploymentMode } from "@/lib/deployment-mode";

const PrivateLiveWorkspace = lazy(() => import("./private-live-workspace"));

export default function Home() {
  const [mode, setMode] = useState<DeploymentMode>("PUBLIC_DEMO");

  useEffect(() => {
    let active = true;
    void fetch("/api/deployment-mode", { cache: "no-store" })
      .then(async (response) => response.ok
        ? response.json() as Promise<{ mode?: string }>
        : null)
      .then((result) => {
        if (active && result?.mode === "PRIVATE_LIVE") setMode("PRIVATE_LIVE");
      })
      .catch(() => {
        // A missing or invalid server response keeps the safe public mode.
      });
    return () => { active = false; };
  }, []);

  if (mode === "PRIVATE_LIVE") {
    return <Suspense fallback={<div className="mode-loading">正在载入私有 Live 工作区…</div>}>
      <PrivateLiveWorkspace />
    </Suspense>;
  }
  return <PublicDemo />;
}
