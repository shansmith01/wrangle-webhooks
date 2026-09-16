import { handleDashboard } from "./dashboard-http";
import { RouteDurableObject } from "./durable-object";
import { handleManagement } from "./management-http";
import { handlePublicIngress } from "./public-ingress";
import { RouterIndex } from "./router-index";

export { RouteDurableObject, RouterIndex };

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (
      url.pathname === "/dashboard" ||
      url.pathname === "/dashboard.json" ||
      url.pathname.startsWith("/dashboard/")
    ) {
      return handleDashboard(request, env, url.pathname);
    }
    if (url.pathname === "/_router" || url.pathname.startsWith("/_router/")) {
      return handleManagement(request, env, url);
    }
    return handlePublicIngress(request, env, ctx, url);
  }
} satisfies ExportedHandler<Env>;
