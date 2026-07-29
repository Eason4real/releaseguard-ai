import { getDeploymentMode } from "@/lib/deployment-mode";

export async function GET() {
  return Response.json({ mode: getDeploymentMode() }, {
    headers: { "Cache-Control": "no-store" },
  });
}
