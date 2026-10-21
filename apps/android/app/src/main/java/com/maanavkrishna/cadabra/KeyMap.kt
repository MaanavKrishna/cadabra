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
