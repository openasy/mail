#!/bin/bash
# End to end against a real Stalwart: starts the version compose.yaml pins in Docker, then e2e/stalwart.ts finishes its
# first start through its API as server/stalwart-setup.ts does, and runs Mail's server against it. Needs Docker.
# Exits non-zero on failure.
set -u
cd "$(dirname "$0")/.."
IMAGE=$(sed -n 's/^ *image: \(stalwartlabs\/stalwart:[^ ]*\).*$/\1/p' compose.yaml)
HTTP=${E2E_SW_PORT:-18080}
IMAP=${E2E_SW_IMAP:-11993}
NAME=mail-e2e-sw
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1; }
cleanup
[ -n "${E2E_KEEP:-}" ] || trap cleanup EXIT
RECOVERY="e2e-recovery-$(openssl rand -hex 8)"
docker run -d --name "$NAME" -p "127.0.0.1:$HTTP:8080" -p "127.0.0.1:$IMAP:993" -e STALWART_RECOVERY_ADMIN="admin:$RECOVERY" "$IMAGE" >/dev/null
for _ in $(seq 1 60); do curl -s -o /dev/null "http://localhost:$HTTP/.well-known/jmap" && break; sleep 1; done
echo "# $IMAGE on port $HTTP"
SW="http://localhost:$HTTP" SW_IMAP_PORT="$IMAP" SW_RECOVERY="$RECOVERY" SW_CONTAINER="$NAME" node e2e/stalwart.ts
status=$?
[ $status -eq 0 ] || docker logs --tail 40 "$NAME"
exit $status
