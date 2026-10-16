#!/usr/bin/env bash
# Builds an Ubuntu WSL2 distro tarball with Docker, the AlphaCI agent archive and a
# first-boot unit that enrolls from /etc/alphaci/enrollment-code, then disables itself.
# Import the tarball with `wsl --import`; docs/runbooks/runbook-onprem-self-enrolling-images.md
# has the steps. Run on Linux as root. The output is a local file: nothing is published.
#
#   sudo scripts/build-onprem-wsl-distro.sh --api <https URL> --archive <agent tar.gz> \
#     --archive-sha256 <hex> [--rootfs <Ubuntu WSL rootfs tar.gz> --rootfs-sha256 <hex>] \
#     [--out <dir>] [--name <distro file name>]
#
# Without --rootfs the Ubuntu noble WSL rootfs is downloaded and checked against the
# SHA256SUMS published beside it. --overlay-only <dir> writes just the configuration
# into an existing root filesystem (no chroot, no packages); the tests use it.
set -euo pipefail

die() { echo "$*" >&2; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
FIRST_BOOT_DIR="$REPO/deploy/onprem/images/first-boot"
ROOTFS_URL="${ALPHACI_ROOTFS_URL:-https://cloud-images.ubuntu.com/wsl/noble/current/ubuntu-noble-wsl-amd64-wsl.rootfs.tar.gz}"

API=""; ARCHIVE=""; ARCHIVE_SHA=""; ROOTFS_TAR=""; ROOTFS_SHA=""
OUT="artifacts/onprem-images"; NAME="alphaci-ubuntu-noble"; OVERLAY_ONLY=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --api) API="${2:?--api needs a value}"; shift 2 ;;
    --archive) ARCHIVE="${2:?--archive needs a value}"; shift 2 ;;
    --archive-sha256) ARCHIVE_SHA="${2:?--archive-sha256 needs a value}"; shift 2 ;;
    --rootfs) ROOTFS_TAR="${2:?--rootfs needs a value}"; shift 2 ;;
    --rootfs-sha256) ROOTFS_SHA="${2:?--rootfs-sha256 needs a value}"; shift 2 ;;
    --out) OUT="${2:?--out needs a value}"; shift 2 ;;
    --name) NAME="${2:?--name needs a value}"; shift 2 ;;
    --overlay-only) OVERLAY_ONLY="${2:?--overlay-only needs a value}"; shift 2 ;;
    *) die "Unknown option: $1" ;;
  esac
done

[[ "$API" =~ ^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$ ]] ||
  die 'Pass --api with the public HTTPS API address (no credentials, query or spaces).'
[[ "$ARCHIVE_SHA" =~ ^[0-9a-f]{64}$ ]] || die 'Pass --archive-sha256 with the archive SHA-256 (64 lowercase hex).'
[ -s "$ARCHIVE" ] || die "Agent archive not found: $ARCHIVE"
printf '%s  %s\n' "$ARCHIVE_SHA" "$ARCHIVE" | sha256sum --check --status || die 'Agent archive checksum mismatch.'

# The image carries the archive, so the first boot installs without a download.
apply_overlay() {
  local root="$1"
  install -d -m 0755 "$root/etc/alphaci" "$root/usr/local/sbin" "$root/opt/alphaci-installer" \
    "$root/etc/systemd/system/multi-user.target.wants"
  # WSL starts systemd, and with it the first-boot unit, only when this option is set.
  printf '[boot]\nsystemd=true\n' > "$root/etc/wsl.conf"
  install -m 0644 "$ARCHIVE" "$root/opt/alphaci-installer/alphaci-agent.tar.gz"
  {
    printf "ALPHACI_API_URL='%s'\n" "$API"
    printf "ALPHACI_ARCHIVE_PATH='%s'\n" /opt/alphaci-installer/alphaci-agent.tar.gz
    printf "ALPHACI_ARCHIVE_SHA256='%s'\n" "$ARCHIVE_SHA"
  } > "$root/etc/alphaci/first-boot.env"
  chmod 0644 "$root/etc/alphaci/first-boot.env"
  install -m 0755 "$FIRST_BOOT_DIR/alphaci-first-boot.sh" "$root/usr/local/sbin/alphaci-first-boot"
  install -m 0644 "$FIRST_BOOT_DIR/alphaci-first-boot.service" "$root/etc/systemd/system/alphaci-first-boot.service"
  # The code is not written here. Placing it at /etc/alphaci/enrollment-code arms the unit.
  ln -sfn ../alphaci-first-boot.service "$root/etc/systemd/system/multi-user.target.wants/alphaci-first-boot.service"
}

if [ -n "$OVERLAY_ONLY" ]; then
  [ -d "$OVERLAY_ONLY" ] || die "Overlay directory not found: $OVERLAY_ONLY"
  apply_overlay "$OVERLAY_ONLY"
  echo "Wrote the first-boot overlay to $OVERLAY_ONLY."
  exit 0
fi

[ "$(id -u)" -eq 0 ] || die 'Run as root: the rootfs needs chroot and root-owned files.'
WORK="$(mktemp -d)"
ROOTFS_DIR="$WORK/rootfs"
cleanup() {
  local mount
  for mount in dev/pts dev sys proc; do
    mountpoint -q "$ROOTFS_DIR/$mount" 2>/dev/null && umount -R -l "$ROOTFS_DIR/$mount" || true
  done
  rm -f "$ROOTFS_DIR/usr/sbin/policy-rc.d"
  # --one-file-system: never descend into a mount that survived the unmount above.
  rm -rf --one-file-system "$WORK"
}
trap cleanup EXIT

if [ -z "$ROOTFS_TAR" ]; then
  ROOTFS_TAR="$WORK/rootfs.tar.gz"
  base="$(basename "$ROOTFS_URL")"
  curl --fail --location --proto '=https' --silent --show-error "$ROOTFS_URL" -o "$ROOTFS_TAR"
  curl --fail --location --proto '=https' --silent --show-error "$(dirname "$ROOTFS_URL")/SHA256SUMS" -o "$WORK/SHA256SUMS"
  ROOTFS_SHA="$(awk -v file="$base" '{ name = $2; sub(/^\*/, "", name); if (name == file) print $1 }' "$WORK/SHA256SUMS")"
  [ -n "$ROOTFS_SHA" ] || die "$base is not listed in SHA256SUMS."
fi
[[ "$ROOTFS_SHA" =~ ^[0-9a-f]{64}$ ]] || die 'Pass --rootfs-sha256 with the rootfs SHA-256 (64 lowercase hex).'
printf '%s  %s\n' "$ROOTFS_SHA" "$ROOTFS_TAR" | sha256sum --check --status || die 'Ubuntu rootfs checksum mismatch.'

mkdir -p "$ROOTFS_DIR"
tar --numeric-owner -xpf "$ROOTFS_TAR" -C "$ROOTFS_DIR"

# Package installation needs DNS inside the chroot; the original file goes back afterwards.
if [ -e "$ROOTFS_DIR/etc/resolv.conf" ] || [ -L "$ROOTFS_DIR/etc/resolv.conf" ]; then
  mv "$ROOTFS_DIR/etc/resolv.conf" "$WORK/resolv.conf.original"
fi
cp -L /etc/resolv.conf "$ROOTFS_DIR/etc/resolv.conf"
mount -t proc proc "$ROOTFS_DIR/proc"
# Recursive slave mounts: unmounting inside the chroot must never reach the build host's /dev or /sys.
mount --rbind /sys "$ROOTFS_DIR/sys"
mount --make-rrslave "$ROOTFS_DIR/sys"
mount --rbind /dev "$ROOTFS_DIR/dev"
mount --make-rrslave "$ROOTFS_DIR/dev"
# Stop packages from starting services inside the chroot; systemd starts them at boot.
printf '#!/bin/sh\nexit 101\n' > "$ROOTFS_DIR/usr/sbin/policy-rc.d"
chmod 0755 "$ROOTFS_DIR/usr/sbin/policy-rc.d"

in_chroot() { chroot "$ROOTFS_DIR" /usr/bin/env DEBIAN_FRONTEND=noninteractive "$@"; }
in_chroot apt-get update
in_chroot apt-get install -y --no-install-recommends \
  ca-certificates curl docker.io docker-compose-v2 iproute2 jq openssl util-linux
in_chroot apt-get clean
rm -rf "$ROOTFS_DIR"/var/lib/apt/lists/*
rm -f "$ROOTFS_DIR/usr/sbin/policy-rc.d"

apply_overlay "$ROOTFS_DIR"
DOCKER_LINK="$ROOTFS_DIR/etc/systemd/system/multi-user.target.wants/docker.service"
# [ -e ] follows the link, so a dangling link from the package would fail the ln; check for the link itself too.
[ -e "$DOCKER_LINK" ] || [ -L "$DOCKER_LINK" ] ||
  ln -s /usr/lib/systemd/system/docker.service "$DOCKER_LINK"

# Unmount before archiving, so the pseudo filesystems stay out of the tarball.
for mount in dev/pts dev sys proc; do umount -R -l "$ROOTFS_DIR/$mount" 2>/dev/null || true; done
rm -f "$ROOTFS_DIR/etc/resolv.conf"
if [ -e "$WORK/resolv.conf.original" ] || [ -L "$WORK/resolv.conf.original" ]; then
  mv "$WORK/resolv.conf.original" "$ROOTFS_DIR/etc/resolv.conf"
fi

mkdir -p "$OUT"
tar --numeric-owner -czf "$OUT/$NAME.tar.gz" -C "$ROOTFS_DIR" .
(cd "$OUT" && sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256")
echo "Built $OUT/$NAME.tar.gz. Import it with wsl --import as the runbook describes."
