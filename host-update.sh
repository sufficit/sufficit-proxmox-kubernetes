#!/bin/bash
# host-update.sh -- atualiza o deploy da integracao k8s/PVE a partir do
# repositorio publico (tarball do GitHub), de forma atomica e reversivel.
#
# O deploy no host NAO e um clone git: este script baixa o tarball da
# RELEASE mais recente (fallback: branch main), extrai em diretorio novo,
# copia os arquivos locais do host, troca os diretorios com um movimento
# atomico, reexecuta o patch_ui.py e roda o manage.sh verify. Se o verify
# falhar apos a troca, restaura o deploy anterior automaticamente.
#
# Uso (no host PVE, como root):
#   bash host-update.sh                  # ultima release (fallback: main)
#   bash host-update.sh --tag v1.0.0     # versao especifica
#   bash host-update.sh --branch main    # ponta da branch main
#   bash host-update.sh --dir /root/k8s-ui --tarball repo.tar.gz
#
# Preservado na troca: tests-local/, backup-*/, *.kubeconfig e
# tests/node_modules (cache do npm). O estado do PVE (desired.json,
# notes.json) vive em /var/lib/pve-manager/k8s e nao e tocado. O deploy
# anterior permanece em <dir>.old-<timestamp> para inspecao/remocao.
set -euo pipefail

REPO="sufficit/sufficit-proxmox-kubernetes"
DEPLOY_DIR=/root/k8s-ui
REF_KIND=release
REF_VALUE=
TARBALL=

die() { printf 'host-update: ERRO: %s\n' "$*" >&2; exit 1; }
log()  { printf '[host-update] %s\n' "$*"; }

usage() { grep '^#' "$0" | grep -v '^#!' | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --tag)     [ $# -ge 2 ] || die "--tag exige valor"; REF_KIND=tag; REF_VALUE=$2; shift 2 ;;
    --branch)  [ $# -ge 2 ] || die "--branch exige valor"; REF_KIND=branch; REF_VALUE=$2; shift 2 ;;
    --release) [ $# -ge 2 ] || die "--release exige valor"; REF_KIND=release; REF_VALUE=$2; shift 2 ;;
    --dir)     [ $# -ge 2 ] || die "--dir exige caminho"; DEPLOY_DIR=$2; shift 2 ;;
    --tarball) [ $# -ge 2 ] || die "--tarball exige caminho"; REF_KIND=tarball; TARBALL=$2; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "opcao desconhecida: $1 (veja --help)" ;;
  esac
done

command -v curl > /dev/null 2>&1 || die "curl nao encontrado"
command -v python3 > /dev/null 2>&1 || die "python3 nao encontrado"
command -v tar > /dev/null 2>&1 || die "tar nao encontrado"

url=
describe=
case "$REF_KIND" in
  tarball)
    [ -n "$TARBALL" ] || die "--tarball exige caminho"
    [ -f "$TARBALL" ] || die "tarball nao encontrado: $TARBALL"
    describe="tarball $(basename "$TARBALL")"
    ;;
  release)
    latest=$(curl -fsSL --connect-timeout 15 --retry 3 \
      "https://api.github.com/repos/$REPO/releases/latest" \
      | python3 -c 'import json,sys; print(json.load(sys.stdin).get("tag_name",""))' 2>/dev/null) \
      || latest=
    if [ -n "${latest:-}" ]; then
      REF_KIND=tag
      REF_VALUE=$latest
    else
      log "sem releases publicadas -- caindo para a branch main"
      REF_KIND=branch
      REF_VALUE=main
    fi
    ;;
esac
case "$REF_KIND" in
  tag)
    url="https://codeload.github.com/$REPO/tar.gz/refs/tags/$REF_VALUE"
    describe="release $REF_VALUE"
    ;;
  branch)
    REF_VALUE=${REF_VALUE:-main}
    url="https://codeload.github.com/$REPO/tar.gz/refs/heads/$REF_VALUE"
    describe="branch $REF_VALUE"
    ;;
esac

PARENT=${DEPLOY_DIR%/*}
mkdir -p "$PARENT"
WORK=$(mktemp -d "$PARENT/k8sui-update.XXXXXX") || die "falha ao criar area temporaria em $PARENT"
trap 'rm -rf "$WORK"' EXIT
NEW=$WORK/new
mkdir -p "$NEW"

log "baixando: $describe"
if [ "$REF_KIND" = tarball ]; then
  tar xzf "$TARBALL" -C "$NEW" --strip-components=1
else
  curl -fsSL --connect-timeout 15 --retry 3 "$url" | tar xz -C "$NEW" --strip-components=1
fi
[ -f "$NEW/patch_ui.py" ] && [ -f "$NEW/manage.sh" ] \
  || die "conteudo baixado nao parece o repositorio (sem patch_ui.py/manage.sh)"

# carimbo de versao (exibido pelo manage.sh verify)
printf '%s @ %s\n' "$describe" "$(date -u '+%F %T UTC')" > "$NEW/.version"

# arquivos locais do host sobrevivem a troca (dados e caches, nao codigo)
shopt -s nullglob
for item in \
  "$DEPLOY_DIR/tests-local" \
  "$DEPLOY_DIR"/backup-* \
  "$DEPLOY_DIR"/*.kubeconfig \
  "$DEPLOY_DIR/tests/node_modules"; do
  [ -e "$item" ] || continue
  rel=${item#"$DEPLOY_DIR"/}
  mkdir -p "$NEW/$(dirname "$rel")"
  cp -a "$item" "$NEW/$rel"
  log "preservado: $rel"
done
shopt -u nullglob

# tarball carrega os modos do git; garantia extra para os executaveis
chmod +x "$NEW/manage.sh" "$NEW/host-update.sh" 2> /dev/null || true
chmod +x "$NEW/k8s-ui-guard" "$NEW/k8snet-apply-node" 2> /dev/null || true

apply_and_verify() {
  ( cd "$DEPLOY_DIR" && python3 patch_ui.py && bash manage.sh verify )
}

STAMP=$(date +%Y%m%d-%H%M%S)
OLD=${DEPLOY_DIR}.old-$STAMP
if [ -d "$DEPLOY_DIR" ]; then
  mv "$DEPLOY_DIR" "$OLD"
  log "deploy anterior preservado em $OLD"
fi
mv "$NEW" "$DEPLOY_DIR"
log "novo deploy ativo em $DEPLOY_DIR"

if apply_and_verify; then
  log "atualizacao concluida: $(head -n1 "$DEPLOY_DIR/.version")"
  exit 0
fi

log "verify FALHOU apos a atualizacao -- restaurando o deploy anterior"
rm -rf "${DEPLOY_DIR}.failed-$STAMP"
mv "$DEPLOY_DIR" "${DEPLOY_DIR}.failed-$STAMP"
if [ -d "$OLD" ]; then
  mv "$OLD" "$DEPLOY_DIR"
  if apply_and_verify; then
    log "rollback concluido: deploy anterior restaurado e verificado"
  else
    log "ATENCAO: verify tambem falhou no deploy restaurado (saida acima)"
  fi
else
  log "ATENCAO: nao havia deploy anterior para restaurar"
fi
exit 1
