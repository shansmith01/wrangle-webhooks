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
import { routerIndexStub } from "./router-index";
import { durableObjectNameForRoute } from "./route-id";
import { timingSafeEqualString } from "./timing-safe-equal";

/** Handle `/dashboard` HTML, login, logout, and status JSON. */
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

  if (request.method !== "GET" && request.method !== "HEAD") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  const authed = await requireDashboardAuth(request, password);
  if (pathname === "/dashboard/status") {
    if (!authed) {
      return unauthorizedDashboard();
    }
    const routes = await loadDashboardRoutes(env);
    return Response.json(dashboardStatus(Boolean(env.DEV_ROUTER_SECRET), routes), {
      headers: { "Cache-Control": "no-store" }
    });
  }

  if (pathname === "/dashboard" || pathname === "/dashboard/login") {
    if (!authed) {
      return dashboardLoginResponse();
    }
    const routes = await loadDashboardRoutes(env);
    const status = dashboardStatus(Boolean(env.DEV_ROUTER_SECRET), routes);
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
      publicPath: routeId === "" ? "/*" : `/${routeId}/*`,
      subscribers
    });
  }
  return routes;
}
