import {
  dashboardSessionClearCookie,
  dashboardSessionSetCookie,
  mintDashboardSession,
  requireDashboardAuth,
  unauthorizedDashboard
} from "./dashboard-session";
import {
  dashboardHtml,
  dashboardHtmlHeaders,
  dashboardLoginHtml,
  dashboardStatus,
  type DashboardRoute
} from "./dashboard";
import { publicPathForRouteId } from "./connection-log";
import { validateOAuthCallbackPath } from "./oauth-callback-path";
import {
  parseWebhookFilterEnvironmentId,
  validateWebhookFanoutRuleMode,
  validateWebhookFilterPath
} from "./webhook-filter-path";
import { routerIndexStub } from "./router-index";
import { durableObjectNameForRoute, isAllowedRouteId } from "./route-id";
import { timingSafeEqualString } from "./timing-safe-equal";

/** Handle `/dashboard` HTML, login, logout, OAuth callback path CRUD, and status JSON. */
export async function handleDashboard(
  request: Request,
  env: Env,
  pathname: string
): Promise<Response> {
  const password = env.DEV_ROUTER_DASHBOARD_PASSWORD;
  if (!password) {
    return Response.json({ error: "dashboard_password_not_configured" }, { status: 503 });
  }

  if (pathname === "/dashboard.json") {
    return Response.redirect(new URL("/dashboard/status", request.url).toString(), 308);
  }

  if (pathname === "/dashboard/login" && request.method === "POST") {
    const submitted = await readDashboardLoginPassword(request);
    if (!submitted || !timingSafeEqualString(submitted, password)) {
      return dashboardLoginResponse("Incorrect password", 401);
    }
    const session = await mintDashboardSession(password);
    return new Response(null, {
      status: 303,
      headers: {
        Location: "/dashboard",
        "Set-Cookie": dashboardSessionSetCookie(request, session),
        "Cache-Control": "no-store"
      }
    });
  }

  if (pathname === "/dashboard/logout" && request.method === "POST") {
    return new Response(null, {
      status: 303,
      headers: {
        Location: "/dashboard",
        "Set-Cookie": dashboardSessionClearCookie(request),
        "Cache-Control": "no-store"
      }
    });
  }

  const authed = await requireDashboardAuth(request, password);

  if (pathname === "/dashboard/oauth-callback-paths" && request.method === "POST") {
    if (!authed) {
      return unauthorizedDashboard();
    }
    return addDashboardOAuthCallbackPath(request, env);
  }

  if (pathname === "/dashboard/oauth-callback-paths/delete" && request.method === "POST") {
    if (!authed) {
      return unauthorizedDashboard();
    }
    return deleteDashboardOAuthCallbackPath(request, env);
  }

  if (pathname === "/dashboard/webhook-fanout" && request.method === "POST") {
    if (!authed) {
      return unauthorizedDashboard();
    }
    return saveDashboardWebhookFanout(request, env);
  }

  if (pathname === "/dashboard/webhook-fanout-rules" && request.method === "POST") {
    if (!authed) {
      return unauthorizedDashboard();
    }
    return addDashboardWebhookFanoutRule(request, env);
  }

  if (pathname === "/dashboard/webhook-fanout-rules/delete" && request.method === "POST") {
    if (!authed) {
      return unauthorizedDashboard();
    }
    return deleteDashboardWebhookFanoutRule(request, env);
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  if (pathname === "/dashboard/status") {
    if (!authed) {
      return unauthorizedDashboard();
    }
    const status = await loadDashboardStatus(env);
    return Response.json(status, {
      headers: { "Cache-Control": "no-store" }
    });
  }

  if (pathname === "/dashboard" || pathname === "/dashboard/login") {
    if (!authed) {
      return dashboardLoginResponse();
    }
    const status = await loadDashboardStatus(env);
    return new Response(dashboardHtml(status), {
      headers: dashboardHtmlHeaders()
    });
  }

  return Response.json({ error: "not_found" }, { status: 404 });
}

function dashboardLoginResponse(error?: string, status = 200): Response {
  return new Response(dashboardLoginHtml(error), {
    status,
    headers: dashboardHtmlHeaders()
  });
}

async function readDashboardLoginPassword(request: Request): Promise<string> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.toLowerCase().includes("application/json")) {
    try {
      const payload: unknown = await request.json();
      if (
        payload &&
        typeof payload === "object" &&
        "password" in payload &&
        typeof payload.password === "string"
      ) {
        return payload.password;
      }
    } catch {
      return "";
    }
    return "";
  }
  const form = await request.formData();
  const password = form.get("password");
  return typeof password === "string" ? password : "";
}

async function addDashboardOAuthCallbackPath(request: Request, env: Env): Promise<Response> {
  const { routeId, path } = await readOAuthCallbackPathForm(request);
  if (!isAllowedRouteId(routeId) || !validateOAuthCallbackPath(path)) {
    return Response.redirect(new URL("/dashboard", request.url).toString(), 303);
  }
  await routerIndexStub(env).addOAuthCallbackPath(routeId, path);
  return Response.redirect(new URL("/dashboard", request.url).toString(), 303);
}

async function deleteDashboardOAuthCallbackPath(request: Request, env: Env): Promise<Response> {
  const { routeId, path } = await readOAuthCallbackPathForm(request);
  if (!isAllowedRouteId(routeId) || !validateOAuthCallbackPath(path)) {
    return Response.redirect(new URL("/dashboard", request.url).toString(), 303);
  }
  await routerIndexStub(env).removeOAuthCallbackPath(routeId, path);
  return Response.redirect(new URL("/dashboard", request.url).toString(), 303);
}

async function readOAuthCallbackPathForm(
  request: Request
): Promise<{ routeId: string; path: string }> {
  const form = await request.formData();
  const routeRaw = form.get("routeId");
  const pathRaw = form.get("path");
  const routeId =
    typeof routeRaw === "string" ? routeRaw.trim() : "";
  const path = typeof pathRaw === "string" ? pathRaw.trim() : "";
  return { routeId, path };
}

async function saveDashboardWebhookFanout(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const routeRaw = form.get("routeId");
  const routeId = typeof routeRaw === "string" ? routeRaw.trim() : "";
  const denyValues = form.getAll("denyAllWebhooks").map((value) => String(value));
  const denyAllWebhooks = denyValues.includes("on");
  if (!isAllowedRouteId(routeId)) {
    return Response.redirect(new URL("/dashboard", request.url).toString(), 303);
  }
  await routerIndexStub(env).setWebhookFanoutDenyAll(routeId, denyAllWebhooks);
  return Response.redirect(new URL("/dashboard", request.url).toString(), 303);
}

async function addDashboardWebhookFanoutRule(request: Request, env: Env): Promise<Response> {
  const { routeId, mode, path, environmentId } = await readWebhookFanoutRuleForm(request);
  if (
    !isAllowedRouteId(routeId) ||
    !validateWebhookFanoutRuleMode(mode) ||
    !validateWebhookFilterPath(path) ||
    !parseWebhookFilterEnvironmentId(environmentId).ok
  ) {
    return Response.redirect(new URL("/dashboard", request.url).toString(), 303);
  }
  await routerIndexStub(env).addWebhookFanoutRule(routeId, mode, path, environmentId);
  return Response.redirect(new URL("/dashboard", request.url).toString(), 303);
}

async function deleteDashboardWebhookFanoutRule(request: Request, env: Env): Promise<Response> {
  const { routeId, mode, path, environmentId } = await readWebhookFanoutRuleForm(request);
  if (!isAllowedRouteId(routeId) || !validateWebhookFanoutRuleMode(mode) || !validateWebhookFilterPath(path)) {
    return Response.redirect(new URL("/dashboard", request.url).toString(), 303);
  }
  await routerIndexStub(env).removeWebhookFanoutRule(routeId, mode, path, environmentId);
  return Response.redirect(new URL("/dashboard", request.url).toString(), 303);
}

async function readWebhookFanoutRuleForm(request: Request): Promise<{
  routeId: string;
  mode: string;
  path: string;
  environmentId: string;
}> {
  const form = await request.formData();
  const routeRaw = form.get("routeId");
  const modeRaw = form.get("mode");
  const pathRaw = form.get("path");
  const envRaw = form.get("environmentId");
  return {
    routeId: typeof routeRaw === "string" ? routeRaw.trim() : "",
    mode: typeof modeRaw === "string" ? modeRaw.trim() : "",
    path: typeof pathRaw === "string" ? pathRaw.trim() : "",
    environmentId: typeof envRaw === "string" ? envRaw.trim() : ""
  };
}

async function loadDashboardStatus(env: Env) {
  const index = routerIndexStub(env);
  const [routes, connectionLog, inboundLog, oauthCallbackPaths, webhookSettings, webhookRules] =
    await Promise.all([
      loadDashboardRoutes(env),
      index.listConnectionEvents(),
      index.listInboundEvents(),
      index.listAllOAuthCallbackPaths(),
      index.listAllWebhookFanoutSettings(),
      index.listAllWebhookFanoutRules()
    ]);
  return dashboardStatus(
    Boolean(env.DEV_ROUTER_SECRET),
    routes,
    connectionLog,
    inboundLog,
    oauthCallbackPaths,
    { settings: webhookSettings, rules: webhookRules }
  );
}

async function loadDashboardRoutes(env: Env): Promise<DashboardRoute[]> {
  const routeIds = await routerIndexStub(env).listRoutes();
  const routes: DashboardRoute[] = [];
  for (const routeId of routeIds) {
    const subscribers = await env.ROUTE.getByName(
      durableObjectNameForRoute(routeId)
    ).getActiveSubscribers();
    if (subscribers.length === 0) {
      await routerIndexStub(env).removeRoute(routeId);
      continue;
    }
    routes.push({
      routeId,
      publicPath: publicPathForRouteId(routeId),
      subscribers
    });
  }
  return routes;
}
