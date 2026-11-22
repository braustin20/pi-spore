# 0191. The service starts with the graphical session

- Status: Accepted; amends [0184](0184-systemd-user-service.md)
- Date: 2026-11-21
- Requirements: R1.1, R10.3

## Context

- The unit of ADR 0184 had `WantedBy=default.target`. The user manager starts `default.target` before the desktop
  (such as KDE Plasma) imports `DISPLAY`, `WAYLAND_DISPLAY`, and `XAUTHORITY` into systemd.
- So the server, and every program it starts, had no display. "Open in Unity" ran `unity open`, which exited 0.
  Then the editor died: `~/.config/unity3d/Editor.log` ended with `Gtk-WARNING **: cannot open display:`.
- A user service without lingering already runs only while the user is logged in.

## Decision

1. The unit has `After=graphical-session.target` under `[Unit]` and `WantedBy=graphical-session.target` under
   `[Install]`. The service starts after the desktop has imported its environment, so it gets the display.
2. The unit has no `PartOf=` or `BindsTo=`. A desktop crash or restart does not stop the server or agent turns.
3. `pi-spore service install` over an existing unit runs `systemctl --user disable pi-spore` before it writes the new
   text. `disable` reads the old `[Install]` and removes its link, such as the one in `default.target.wants`. It does
   not stop the service. Then install runs `daemon-reload` and `enable --now pi-spore`, as before.

## Consequences

- Programs the server starts, such as the Unity editor, can open windows.
- The service does not start on a login with no desktop, such as SSH only. `pi-spore start` still works there.
- `loginctl enable-linger` no longer starts the service at boot, because no graphical session runs then.
- A user who installed the service before this change runs `pi-spore service install` once, then logs out and in.
