---
type: "Playbook"
title: "On-prem self-enrolling images"
description: "Build and start an Ubuntu VM or a WSL2 distro that enrolls itself with AlphaCi on first boot from a one-time code."
tags: [runbook, runtime, deployment, on-prem]
status: draft
sources:
  - id: images
    resource: "deploy/onprem/images"
    title: "First-boot unit, cloud-init template"
  - id: wsl-build
    resource: "scripts/build-onprem-wsl-distro.sh"
    title: "WSL distro builder"
  - id: user-data
    resource: "scripts/render-onprem-user-data.mjs"
    title: "cloud-init user-data renderer"
  - id: host-setup
    resource: "/runbooks/runbook-onprem-host-setup.md"
    title: "On-prem host setup"
---
# On-prem self-enrolling images

Two images let a machine enroll itself the first time it starts: an Ubuntu VM
configured by cloud-init, and a WSL2 distro imported with `wsl --import`. Both
carry the agent archive, pinned by SHA-256, and a first-boot unit. The one-time
enrollment code is the only per-machine secret. It works once and expires 10
minutes after Hosting issues it.

Nothing here is published. You build the image yourself from a release archive.

## Before you start

- A public HTTPS address for the AlphaCi API.
- The agent archive `alphaci-agent-<version>.tar.gz` and its SHA-256, from the
  release, or from `node scripts/package-onprem-agent.mjs` (see `artifacts/onprem/`).
- An enrollment code from Hosting, issued for the new machine. Issue it right
  before you start the machine. For the WSL image, issue it after you import the distro.

## Ubuntu VM with cloud-init

1. Write the code to a file that holds nothing else, then render the user-data
   on a trusted machine:

   ```bash
   node scripts/render-onprem-user-data.mjs \
     --api https://YOUR-API \
     --archive-url https://YOUR-ARCHIVE-URL \
     --archive-sha256 YOUR-SHA256 \
     --code-file ./enrollment-code.txt \
     --out ./user-data.yaml
   ```

   The renderer checks every value, reads the code from the file (never from the
   command line), and writes `user-data.yaml` with mode 0600.
2. Give `user-data.yaml` to the VM as its cloud-init user-data, and start the VM
   on Ubuntu 24.04. cloud-init installs Docker and the packages, writes the code
   to `/etc/alphaci/enrollment-code`, and starts `alphaci-first-boot.service`.
3. Follow the first boot on the VM: `journalctl -u alphaci-first-boot.service`.
   It ends with "Enrolled on first boot". The machine then shows as connected in
   Hosting, and you assign environments to it there.
4. Delete `enrollment-code.txt` and `user-data.yaml`.

## WSL2 distro

Build on a Linux machine with root and network access:

```bash
sudo scripts/build-onprem-wsl-distro.sh \
  --api https://YOUR-API \
  --archive ./alphaci-agent-VERSION.tar.gz \
  --archive-sha256 YOUR-SHA256 \
  --out ./images
```

The script downloads the Ubuntu noble WSL rootfs, checks it against the
`SHA256SUMS` published beside it, installs Docker Compose v2 and Docker Engine in
a chroot, and writes `images/alphaci-ubuntu-noble.tar.gz` with a `.sha256` file.
Verify it with `sha256sum -c alphaci-ubuntu-noble.tar.gz.sha256`. To use a rootfs
you already have, pass `--rootfs` with `--rootfs-sha256`. The image contains the
archive but no enrollment code.

Import it on the Windows machine, in the account that will own the distro:

```powershell
wsl.exe --import AlphaCI-Host C:\WSL\AlphaCI-Host .\alphaci-ubuntu-noble.tar.gz --version 2
```

Issue the code now, copy it to the clipboard, then write it into the distro from
there. The code never goes into a PowerShell variable, command history or a command
line. Clear the clipboard afterwards:

```powershell
Get-Clipboard | wsl.exe -d AlphaCI-Host -u root -- sh -c 'umask 077 && cat > /etc/alphaci/enrollment-code'
```

That first start booted without the code, so the unit was skipped. Start the unit
now. `systemctl start` waits for the enrollment to finish, which keeps the distro
running until then:

```powershell
wsl.exe -d AlphaCI-Host -u root -- systemctl start alphaci-first-boot.service
wsl.exe -d AlphaCI-Host -u root -- journalctl -u alphaci-first-boot.service --no-pager
```

Wait for "Enrolled on first boot", then open the host in Hosting and check it is
connected. The Windows startup and port forwarding are set up separately, with the
installer from the release's `windows` folder. The machine is already enrolled, so
it needs no code:

```powershell
.\Install-AlphaCIHost.ps1 -Distro AlphaCI-Host -ClientSubnets LocalSubnet -ApiUrl https://YOUR-API -OnlyWhenSignedIn
```

## When it does not enroll

- **No code is waiting.** The unit is skipped, not failed. Write the code, then
  start the unit: `sudo systemctl start alphaci-first-boot.service` on the VM, or
  the WSL command in the section above.
- **The API does not answer.** The unit waits up to about 10 minutes for the API
  before it reads the code. Only connection and DNS failures are retried. If the
  wait ends, the code is still in place: fix the network, then start the unit again.
  The wait counts against the code's 10 minutes, so a long outage can expire it.
- **Prerequisites missing** (Docker not running, systemd not enabled). The installer
  stops before it reads the code, so the code stays in place. Fix the machine and
  start the unit again, as above.
- **Archive checksum mismatch.** Nothing is installed and the unit stays enabled.
  Rebuild with the correct archive checksum.
- **Code expired or already used.** The unit disables itself after a successful
  enrollment, so a VM that enrolled cannot take a new code by restarting. Recreate
  the VM, or run `cloud-init clean` and reboot. For WSL, import the tarball again.
  If the code expired before you used it, render or issue a new one.

## The code

Anyone holding the code can enroll the machine until it is used or expires. The
user-data file, the enrollment code file and the copy inside the VM are all secrets
until enrollment is complete, and the first-boot unit deletes the code once the
installer reads it. Delete any copies you made. Keep the built WSL tarball, which
has no code in it.
