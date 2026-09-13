export interface DetectedPublicUrl {
  url: string;
  source: string;
}

const DEFAULT_PORT = 3000;

export function resolveDevPort(
  env: NodeJS.ProcessEnv = process.env,
  explicitPort?: number
): number {
  if (explicitPort !== undefined) {
    return explicitPort;
  }
  const raw = env.DEV_ROUTER_PORT ?? env.PORT;
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_PORT;
}

export function detectPublicDevUrl(
  env: NodeJS.ProcessEnv = process.env,
  explicitPort?: number
): DetectedPublicUrl | undefined {
  const port = resolveDevPort(env, explicitPort);

  const vscodeProxy = env.VSCODE_PROXY_URI?.trim();
  if (vscodeProxy) {
    const url = vscodeProxy.replaceAll("{{port}}", String(port)).replaceAll("{port}", String(port));
    if (url.startsWith("https://")) {
      return { url, source: "VS Code port forwarding" };
    }
  }

  const codespaceName = env.CODESPACE_NAME?.trim();
  const codespaceDomain = env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN?.trim();
  if (codespaceName && codespaceDomain) {
    return {
      url: `https://${codespaceName}-${port}.${codespaceDomain}`,
      source: "GitHub Codespaces"
    };
  }

  const gitpodWorkspaceUrl = env.GITPOD_WORKSPACE_URL?.trim();
  if (gitpodWorkspaceUrl) {
    try {
      const host = new URL(gitpodWorkspaceUrl).host;
      return {
        url: `https://${port}-${host}`,
        source: "Gitpod"
      };
    } catch {
      // Fall through to other detectors.
    }
  }

  const replitDomain = env.REPLIT_DEV_DOMAIN?.trim();
  if (replitDomain) {
    return {
      url: replitDomain.startsWith("https://") ? replitDomain : `https://${replitDomain}`,
      source: "Replit"
    };
  }

  return undefined;
}
