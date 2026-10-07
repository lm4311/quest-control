# Quest Control

A small web panel for a USB-connected Meta Quest. It shows whether the headset is awake and
whether it is set to stay on, and gives you buttons for the adb commands you would otherwise type.

## What it does

- **Wake / Sleep** the headset
- **Always-on**: keeps the headset awake while it is off your head (worn override + stay awake on power)
- **Re-apply automatically**: turns always-on back on after a reboot or reconnect
- **Pause boundary**, **Reboot headset**, **Restart ADB**
- Live status: connection, awake or asleep, always-on state, battery level, charging and temperature

## Installing it

You need [Node.js](https://nodejs.org) and `adb` (Android platform-tools), and a Quest in developer
mode with USB debugging allowed.

1. Download [Install Quest Control.bat](https://lm4311.github.io/quest-control/Install%20Quest%20Control.bat) and run it.
   Windows may warn about a downloaded script; choose "More info" then "Run anyway".
2. It copies Quest Control to `%LOCALAPPDATA%\QuestControl` and puts a **Quest Control** shortcut with
   the headset icon on your Desktop. Run the installer again any time to update.

To put it on the taskbar, right-click the shortcut, choose "Show more options", then "Pin to taskbar".

## Running it

1. Plug the Quest in over USB-C.
2. Open **Quest Control** from the Desktop (or double-click `Start Quest Control.bat` in the folder).

The panel opens at `http://127.0.0.1:8722`. Keep the window open while you use it.

## The hosted page

`index.html` also works as a hosted page (GitHub Pages). A website cannot run adb by itself, so the
hosted page talks to the helper above on the same PC: it only works while `Start Quest Control.bat`
is running. The helper only accepts requests from its own page and from the origins listed in
`HOSTED_ORIGINS` in `server.js` (or the `QUEST_CONTROL_ORIGINS` environment variable).

If adb is not found, set the `ADB_PATH` environment variable to the full path of `adb.exe`.
