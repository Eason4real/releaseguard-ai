type GithubConnectionRequest = {
  config?: {
    owner?: string;
    repo?: string;
    token?: string;
  };
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });

export async function POST(request: Request) {
  let payload: GithubConnectionRequest;
  try {
    payload = await request.json() as GithubConnectionRequest;
  } catch {
    return json({ error: "请求格式不正确。" }, 400);
  }

  const owner = payload.config?.owner?.trim();
  const repo = payload.config?.repo?.trim();
  const token = payload.config?.token?.trim();
  if (!owner || !repo || !token) {
    return json({ error: "GitHub 连接信息不完整。" }, 400);
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    return json({ error: "GitHub 仓库地址格式不正确。" }, 400);
  }

  try {
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "ReleaseGuard-AI",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    const result = await response.json().catch(() => null) as { full_name?: string; message?: string } | null;
    if (!response.ok) {
      return json({ error: `GitHub 连接失败：${result?.message || response.statusText}` }, response.status);
    }
    return json({ message: `连接成功：${result?.full_name || `${owner}/${repo}`}` });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "GitHub 请求失败，请稍后重试。" }, 502);
  }
}
