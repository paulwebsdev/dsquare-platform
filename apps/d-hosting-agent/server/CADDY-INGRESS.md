# D Hosting Private Caddy Ingress (Linux host)

This is the production-host provisioning contract for the private ingress code. It is intentionally separate from the Windows development environment. Do not run customer workloads on the D Hosting API host or on a developer PC.

## Network layout

- Rootless Podman runs the Caddy proxy and every website runtime on the same pre-created private network, `dsquare-private`.
- Website containers have no published host ports. Caddy reaches them using the deployment-specific alias `dsquare-deploy-<deployment-id>.runtime.dsquare.internal:3000`.
- Caddy publishes public HTTP/HTTPS through host ports 8080/8443. Configure the server firewall or upstream load balancer to forward public TCP 80 to host TCP 8080 and public TCP 443 to host TCP 8443. Forward UDP 443 to host UDP 8443 if HTTP/3 is desired.
- The Caddy admin API is reachable by the agent only at host loopback `127.0.0.1:2019`. Never open TCP 2019 in the firewall or publish it on a public/private interface.
- The agent uses `RUNTIME_AGENT_CADDY_ADMIN_URL=http://127.0.0.1:2019/`. The Caddy process listens on `0.0.0.0:2019` inside its container because Podman forwards the host-loopback port to the container.

## One-time rootless Podman setup

Run these commands as the dedicated, non-root runtime-agent service account on the Linux host. Confirm the Podman socket and storage roots are owned by that account.

```sh
podman network create dsquare-private
podman volume create dsquare-caddy-data
podman volume create dsquare-caddy-config
mkdir -p "$HOME/dsquare-caddy"
cat > "$HOME/dsquare-caddy/bootstrap.json" <<'JSON'
{
  "admin": { "listen": "0.0.0.0:2019" },
  "apps": {}
}
JSON
```

Pull and verify the approved Caddy image, then pin its immutable digest in the deployment command used by the host operator. Do not allow the runtime agent or customer request to choose a proxy image.

```sh
podman pull docker.io/library/caddy:2.10.2
podman image inspect docker.io/library/caddy:2.10.2 --format '{{.Digest}}'
```

Start Caddy on the shared private network with persistent certificate/configuration storage. Replace the image tag with the verified digest before production.

```sh
podman run -d \
  --name dsquare-caddy \
  --restart unless-stopped \
  --network dsquare-private \
  -p 8080:80/tcp \
  -p 8443:443/tcp \
  -p 8443:443/udp \
  -p 127.0.0.1:2019:2019/tcp \
  -v dsquare-caddy-data:/data \
  -v dsquare-caddy-config:/config \
  -v "$HOME/dsquare-caddy/bootstrap.json:/etc/caddy/bootstrap.json:ro" \
  docker.io/library/caddy:2.10.2 \
  caddy run --config /etc/caddy/bootstrap.json --adapter json
```

The `/data` volume persists ACME account keys and issued certificates; `/config` persists Caddy's autosaved configuration. Back up these volumes securely and restrict access to the runtime-agent service account. Never place them in a public web root.

## Agent and runtime configuration

- Set `RUNTIME_AGENT_PODMAN_NETWORK=dsquare-private` so website containers join the same network.
- Set `RUNTIME_AGENT_CADDY_ADMIN_URL=http://127.0.0.1:2019/`.
- Keep runtime execution and builder flags disabled until the Linux acceptance checklist below passes.
- Make sure the agent process can access only its rootless Podman Unix socket; do not expose the Podman API on TCP.
- Caddy must have outbound DNS/ACME connectivity and inbound public HTTP/HTTPS reachability. Ensure the public DNS A/AAAA records point to this server and remove unreachable AAAA records.
- Use a valid operations email via the ingress TLS email setting if configured.

## Acceptance checklist before enabling customer execution

1. Verify `podman network inspect dsquare-private` includes the Caddy container and that a test runtime on that network resolves its deployment alias.
2. Verify the host listens on `127.0.0.1:2019` only; a connection to the server's public IP on 2019 must fail.
3. Verify Caddy admin `/config/` can be reached from the agent host but not from another host.
4. Publish a test hostname whose A/AAAA records point to this server; confirm HTTP challenge reachability and automatic certificate issuance.
5. Confirm HTTPS requests route only to the expected deployment alias and that forwarded headers are overwritten by Caddy.
6. Restart Caddy and the agent; verify certificates and the active ingress configuration survive restart.
7. Exercise deployment readiness, cutover, rollback, stop/restart, orphan reconciliation, and cleanup using two versions of a test website.
8. Verify resource limits, no host port on website containers, no customer access to Podman socket/Caddy admin, and no unintended egress from build containers.
9. Keep execution disabled if any item fails. Record test output and the exact Caddy/Podman image digests before approval.

This guide documents the intended topology; it does not claim the live Linux acceptance tests have already been run.
