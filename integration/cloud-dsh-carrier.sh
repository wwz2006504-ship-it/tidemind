#!/bin/bash
# Cloud DSH carrier. Rollback: run this script with --rollback.
set -euo pipefail

stage=/srv/tidemind-staging
root=$stage/dsh-launcher-0.2.1-rc.2
name=tidemind-cloud-dsh-carrier.service
unit=/etc/systemd/system/$name
marker='# TideMind private DSH carrier v1'

case "${1:-}" in
  --dry-run)
    printf '%s\n' "Would install and start $name at 127.0.0.1:17890 with its own DSH home."
    exit 0
    ;;
  --rollback)
    if [[ -e "$unit" || -L "$unit" ]]; then
      [[ ! -L "$unit" && "$(head -n 1 "$unit")" == "$marker" ]]
      systemctl disable --now "$name"
    fi
    exit 0
    ;;
  '') ;;
  *) exit 2 ;;
esac

[[ "$(realpath "$root")" == "$root" ]]
[[ "$(cat "$stage/OWNER")" == 'TideMind candidate staging v1' ]]
[[ "$(cat "$root/OWNER")" == 'TideMind isolated DSH launcher v1' ]]
[[ ! -L "$unit" && ! -L "$root/carrier-home" ]]
install -d -m 700 "$root/carrier-home"
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
cat > "$tmp" <<'UNIT'
# TideMind private DSH carrier v1
[Unit]
Description=TideMind private cloud DSH carrier
After=network.target

[Service]
WorkingDirectory=/srv/tidemind-staging/dsh-launcher-0.2.1-rc.2/carrier-home
Environment=DSH_HOME=/srv/tidemind-staging/dsh-launcher-0.2.1-rc.2/carrier-home
Environment=DSH_TELEMETRY_DISABLED=1
ExecStart=/srv/tidemind-staging/runtime/node-v24.17.0-linux-x64/node /srv/tidemind-staging/dsh-launcher-0.2.1-rc.2/node_modules/@deepseek-ai/dsh/lib/bin.js --profile web --no-open --host 127.0.0.1 --port 17890
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/srv/tidemind-staging/dsh-launcher-0.2.1-rc.2/carrier-home
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
if [[ -e "$unit" ]]; then
  cmp "$unit" "$tmp"
else
  install -m 644 "$tmp" "$unit"
fi
systemctl daemon-reload
systemctl enable --now "$name"
for (( attempt=0; attempt<35; attempt++ )); do
  if systemctl is-active --quiet "$name" &&
     ss -H -lntp '( sport = :17890 )' | grep -Fq "127.0.0.1:17890"; then
    printf '%s\n' 'DSH carrier listening on private loopback.'
    exit 0
  fi
  sleep 1
done
systemctl disable --now "$name"
printf '%s\n' 'DSH carrier failed to listen and was stopped. Private state retained.' >&2
exit 1
