# D Hosting Node API routing

D Hosting gives every verified custom domain attached to a Node website a paired API hostname. The API hostname is routed by the private Caddy ingress to the **same immutable deployment** as the website hostname; it does not expose a container port or create a second runtime.

## Hostname and DNS rules

| Website hostname | Generated API hostname | DNS record |
| --- | --- | --- |
| `example.com` | `api.example.com` | CNAME `api.example.com` → `example.com` |
| `www.example.com` | `api.example.com` | CNAME `api.example.com` → `www.example.com` |
| `shop.example.com` | `api.shop.example.com` | CNAME `api.shop.example.com` → `shop.example.com` |

Apex and `www` aliases for the same website deployment share one API hostname. If that hostname is already registered as another custom domain (including a pending or static-site domain), ingress synchronization fails closed rather than routing one hostname to two websites.

The D Hosting custom-domain API returns `api_enabled`, `api_domain`, `api_dns_record_type`, and `api_dns_record_value` for Node websites. Static websites do not receive an API hostname. Add the returned CNAME alongside the existing website DNS records. The existing `_dsquare-verification.<domain>` TXT ownership challenge remains required for each website custom domain.

## Frontend-to-backend requests

- A frontend can call a same-origin relative path such as `/api/orders` when the Node application serves that route on the website hostname.
- A frontend can call the paired API origin, for example `https://api.example.com/api/orders`, when the application intentionally separates API requests onto the API hostname.
- The API hostname is a second public HTTPS origin. The application backend must allow the exact frontend origin in its CORS policy. Do not use wildcard origins with credentialed requests. CORS is enforced by the customer's application, not by D Hosting's product API.
- For cookie-based sessions across the website/API hostnames, configure cookie domain, `Secure`, `SameSite`, and credentialed CORS deliberately. Prefer bearer tokens or same-origin relative requests where appropriate.
- Server-to-server requests are not governed by browser CORS; authenticate them in the application.

## Runtime port contract

D Hosting owns the private runtime port. The Node process must listen on `process.env.PORT`; the platform supplies `PORT=3000` and the private Caddy route forwards to that port. Do not publish a container port, bind to a public interface, or expect the platform to allocate arbitrary customer-selected ports. Runtime containers communicate with Caddy over the private Podman network using a deployment-specific internal DNS alias.

## Security and rollout

- The API alias is generated only for verified custom domains belonging to published Node websites.
- API and website hostnames route to the same resource/deployment identity; deployment cutover updates both together.
- Caddy provisions HTTPS for both hostnames and redirects HTTP to HTTPS.
- Private ingress administration remains loopback-only. Customer containers have no public host ports.
- The runtime agent continues to require HMAC-authenticated ingress updates from the trusted D Hosting API.
- Runtime execution remains disabled until the dedicated Linux host passes the full acceptance checklist. CI tests do not replace live DNS, certificate, browser CORS, or end-to-end backend checks.
