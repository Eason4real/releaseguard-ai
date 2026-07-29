export const DEPLOYMENT_MODES = ["PUBLIC_DEMO", "PRIVATE_LIVE"] as const;

export type DeploymentMode = (typeof DEPLOYMENT_MODES)[number];

export const PUBLIC_DEMO_DISABLED_CODE = "PUBLIC_DEMO_OPERATION_DISABLED";

export function resolveDeploymentMode(value: unknown): DeploymentMode {
  return value === "PRIVATE_LIVE" ? "PRIVATE_LIVE" : "PUBLIC_DEMO";
}

export function getDeploymentMode(): DeploymentMode {
  return resolveDeploymentMode(process.env.RELEASEGUARD_DEPLOYMENT_MODE);
}

export function blockPublicDemoOperation(): Response | null {
  if (getDeploymentMode() !== "PUBLIC_DEMO") return null;
  return Response.json({
    code: PUBLIC_DEMO_DISABLED_CODE,
    error: "公开演示模式不提供共享数据或外部服务操作。",
  }, {
    status: 403,
    headers: { "Cache-Control": "no-store" },
  });
}

export function isLocalSchemaAutoMigrationEnabled(
  env: { NODE_ENV?: string; RELEASEGUARD_SCHEMA_MODE?: string } = process.env,
) {
  return (env.NODE_ENV === "development" || env.NODE_ENV === "test")
    && env.RELEASEGUARD_SCHEMA_MODE === "LOCAL_AUTO";
}

export function isHostedCorpusImportEnabled(modeValue: unknown, importFlag: unknown) {
  return resolveDeploymentMode(typeof modeValue === "string" ? modeValue : undefined) === "PRIVATE_LIVE"
    && importFlag === "true";
}
