#!/usr/bin/env bash
# Screenshot and probe the native dock. The preview link
# (ahdclient://dock?preview=collapsed|expanded) draws the dock with canned
# figures and no network, so every run shows the same thing. Then drive it the
# way a player would (drag up, Back, tap the strip) and read the accessibility
# tree to check what is on screen. Prints DOCK lines for the log; never fails
# the job: screenshots and probes are evidence, not a gate. Writes to probe/.
set -u
pkg=net.lakesidegames.ahdclient
mkdir -p probe
a() { timeout 40 adb "$@"; }
shot() { a exec-out screencap -p > "probe/dock-$1.png"; }

size=$(a shell wm size | sed -n 's/.*: *\([0-9]*x[0-9]*\).*/\1/p' | tail -1)
width=${size%x*}; height=${size#*x}
width=${width:-1080}; height=${height:-2400}

dump() {
  a shell uiautomator dump /sdcard/dock-ui.xml >/dev/null 2>&1
  a shell cat /sdcard/dock-ui.xml > probe/dock-ui.xml 2>/dev/null
}

# has "<prefix>": is a node with that content description on screen?
has() {
  python3 - "$1" <<'PY'
import re, sys
xml = open("probe/dock-ui.xml", encoding="utf-8", errors="ignore").read()
sys.exit(0 if any(f'content-desc="{sys.argv[1]}' in n for n in re.findall(r"<node [^>]*>", xml)) else 1)
PY
}

# center "<prefix>": print the x y centre of the first node whose description starts so.
center() {
  python3 - "$1" <<'PY'
import re, sys
xml = open("probe/dock-ui.xml", encoding="utf-8", errors="ignore").read()
for n in re.findall(r"<node [^>]*>", xml):
    if f'content-desc="{sys.argv[1]}' in n:
        m = re.search(r'bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', n)
        if m:
            x1, y1, x2, y2 = map(int, m.groups())
            print((x1 + x2) // 2, (y1 + y2) // 2)
            break
PY
}

check() {
  if "${@:2}"; then echo "DOCK ok: $1"; else echo "DOCK FAILED: $1"; fi
}
absent() { ! has "$1"; }

preview() {
  a shell am start -W -n "$pkg/.MainActivity" -a android.intent.action.VIEW -d "ahdclient://dock?preview=$1" >/dev/null
  sleep 5
}

# The Ask screenshots leave their sheet open over the app: close it, then
# bring the app back (it may have exited on the second Back; this relaunches it).
a shell input keyevent 4; sleep 2
a shell input keyevent 4; sleep 2
a shell am start -W -n "$pkg/.MainActivity" >/dev/null
sleep 12
# The sign-in walk can leave the keyboard up; it rightly hides the dock.
if a shell dumpsys input_method 2>/dev/null | grep -q "mInputShown=true"; then
  a shell input keyevent 4
  sleep 2
fi
a shell cmd uimode night yes >/dev/null 2>&1
sleep 2

preview collapsed
shot 1-collapsed
dump
for tab in Game Briefing "Inbox, 3 unread" Ask More "Status. Next turn"; do check "collapsed shows '$tab'" has "$tab"; done
check "collapsed hides the sheet rows" absent "Campaign funds"

# Drag the dock up the way a thumb would, starting on its tab row.
read -r gx gy < <(center "Game") || true
a shell input swipe "$((width / 2))" "${gy:-$((height - 60))}" "$((width / 2))" "$((height * 35 / 100))" 350
sleep 2
shot 2-dragged-open
dump
check "drag up opens the sheet" has "Campaign funds"
check "sheet lists corporate cash" has "Corporate cash"
check "sheet lists the inbox" has "Notifications, 3 unread"

# Back closes the sheet before leaving the app.
a shell input keyevent 4
sleep 2
dump
check "Back closes the sheet" absent "Campaign funds"
check "Back kept the app open" has "Game"

# Tap the strip to open, tap it again to close.
dump
read -r x y < <(center "Status.") || true
if [ -n "${x:-}" ]; then
  a shell input tap "$x" "$y"; sleep 2
  shot 3-tapped-open
  dump
  check "tapping the strip opens the sheet" has "Campaign funds"
  read -r x y < <(center "Status.") || true
  [ -n "${x:-}" ] && a shell input tap "$x" "$y"; sleep 2
  dump
  check "tapping the strip again closes it" absent "Campaign funds"
else
  echo "DOCK FAILED: no strip to tap"
fi

# The finished look, dark and light system themes.
preview expanded
shot 4-expanded-dark
a shell cmd uimode night no >/dev/null 2>&1
sleep 3
preview expanded
shot 5-expanded-light
preview collapsed
shot 6-collapsed-light
dump
check "light theme keeps the dock" has "Game"

# Largest font scale: nothing should clip or overlap.
a shell settings put system font_scale 1.6
sleep 2
preview collapsed
shot 7-collapsed-large-font
preview expanded
shot 8-expanded-large-font
a shell settings put system font_scale 1.0
a shell cmd uimode night no >/dev/null 2>&1
echo "Dock screenshots: $(ls probe/dock-*.png 2>/dev/null | tr '\n' ' ')"
exit 0
