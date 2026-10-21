package com.maanavkrishna.cadabra

import android.view.KeyEvent

/** Maps an Android key code to the name passed to window.cadabraKey, or null if unmapped. */
fun keyName(keyCode: Int): String? = when (keyCode) {
    KeyEvent.KEYCODE_DPAD_UP -> "up"
    KeyEvent.KEYCODE_DPAD_DOWN -> "down"
    KeyEvent.KEYCODE_DPAD_LEFT -> "left"
    KeyEvent.KEYCODE_DPAD_RIGHT -> "right"
    KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER -> "select"
    KeyEvent.KEYCODE_BACK -> "back"
    KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> "playpause"
    KeyEvent.KEYCODE_MENU -> "menu"
    else -> null
}

/** Keys the system must handle itself (Home and volume); everything else is swallowed by the app. */
fun shouldPassToSystem(keyCode: Int): Boolean = when (keyCode) {
    KeyEvent.KEYCODE_HOME,
    KeyEvent.KEYCODE_VOLUME_UP,
    KeyEvent.KEYCODE_VOLUME_DOWN,
    KeyEvent.KEYCODE_VOLUME_MUTE -> true
    else -> false
}

/** Decides whether Back should close the app, from evaluateJavascript's (JSON-quoted) result. */
fun backShouldExit(result: String?): Boolean = when (result?.trim('"')) {
    null, "exit", "missing", "error" -> true
    else -> false
}
