# User services

Service installation is opt-in. `npm install` does not change your login items, systemd units, scheduled tasks, MCP configurations or cloud accounts.

## Install and run

Build the checkout and install the global shim using the README, then install LCU and check `lcu-auto doctor`. Create the local token with `lcu-auto token`. Then:

```sh
lcu-auto service install
lcu-auto service start
lcu-auto service status
```

The definition points to the resolved Node executable and the installed `dist/cli.js`, not the source checkout. Arguments are explicit so a GUI login does not need to source your shell profile. Access configuration and token paths are references, not secret values.

Use `service install --dry-run` to inspect the native definition and registration commands without writing them. Use `--name NAME` consistently to run an additional instance; choose a different port and credentials as appropriate.

## Platform behavior

On macOS, a user LaunchAgent lives under `~/Library/LaunchAgents`. It starts in the logged-in GUI domain and restarts on exit. Logs are written under the state directory's `logs` folder. A cold boot blocked by FileVault still needs local unlock and login.

On Linux, a systemd **user** service lives under `~/.config/systemd/user`. Installation runs daemon-reload and enables the unit, but does not start it. It requires a functioning user systemd manager and suitable graphical environment. It does not enable linger or alter the system manager. Use `journalctl --user -u lcu-auto.service` for logs.

On Windows, Task Scheduler receives an XML definition for the current interactive user at logon, using least privilege and no stored password. This service integration does not make the deferred upstream Windows desktop backend supported. Test the rendered task and account permissions on your own Windows host before relying on it.

Definitions and argument quoting are tested for all three platforms. Only macOS installation and runtime are locally live-verified for this release.

## Stop, restart and upgrade

```sh
lcu-auto service stop
lcu-auto service restart
```

Stop/restart check authenticated broker health and refuse while clients remain, or when health cannot be read. `--force-disconnect` explicitly accepts interruption. This includes idle retained conversation contexts, not only active clicks. A stop waits for launchd to actually unload before a replacement is bootstrapped.

For the current source distribution, fast-forward the checkout, rebuild and reinstall the shim; stop the old service, then run `service install` again to update paths/arguments when necessary. Existing definitions are backed up. A definition not marked as managed by lcu-auto requires explicit `--replace-existing`; a currently registered service must be stopped before replacement.

No rollback deletes user data. Restore the prior package and backed-up service definition, keeping the same private token/configuration. Avoid changing credentials solely to recover from a code upgrade.

## Uninstall

Stop the broker first. macOS: remove its LaunchAgent file through your normal file manager. Linux: disable the user unit, remove its definition and reload the user manager. Windows: delete the named task in Task Scheduler. Then uninstall the package with `npm uninstall --global lcu-auto`.

Configuration, backups and credentials are intentionally not deleted automatically. Revoke or remove them yourself when retiring the service. A separately managed Cloudflare Tunnel must also be stopped or removed independently.
