#!/bin/bash
# Cria/remove um usuario PVE temporario para a suite Playwright.
# Rodar COMO ROOT NO HOST PVE (o teste roda na estacao de trabalho).
#
#   bash pve-test-user.sh create   # imprime as variaveis de ambiente
#   bash pve-test-user.sh remove   # apaga usuario e role
#
# O usuario recebe apenas Sys.Audit + Sys.Modify + Sys.Console em "/",
# exatamente as capacidades que o menu de contexto k8sapp consulta.
# Nao ha senha fixa: e sorteada a cada create e impressa uma unica vez.
set -euo pipefail

USER_ID="k8s-test@pve"
ROLE_ID="K8sTestRole"

case "${1:-}" in
create)
    PW=$(openssl rand -hex 16)
    pveum role add "$ROLE_ID" -privs 'Sys.Audit Sys.Modify Sys.Console' 2>/dev/null || true
    pveum user delete "$USER_ID" 2>/dev/null || true
    pveum user add "$USER_ID" --password "$PW" \
        --comment 'temporario - suite de testes do menu k8sapp'
    pveum aclmod / -users "$USER_ID" -roles "$ROLE_ID"
    echo
    echo "# use na estacao onde a suite roda:"
    echo "export PVE_URL=https://$(hostname -f):8006/"
    echo "export PVE_USER=$USER_ID"
    echo "export PVE_PASSWORD='$PW'"
    ;;
remove)
    pveum user delete "$USER_ID" 2>/dev/null || true
    pveum role delete "$ROLE_ID" 2>/dev/null || true
    echo "usuario e role de teste removidos"
    ;;
*)
    echo "uso: $0 {create|remove}" >&2
    exit 2
    ;;
esac
