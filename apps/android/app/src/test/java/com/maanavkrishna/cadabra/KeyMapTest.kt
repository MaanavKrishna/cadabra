package com.maanavkrishna.cadabra

import android.view.KeyEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class KeyMapTest {
    @Test
    fun mapsKnownKeys() {
        assertEquals("up", keyName(KeyEvent.KEYCODE_DPAD_UP))
        assertEquals("down", keyName(KeyEvent.KEYCODE_DPAD_DOWN))
        assertEquals("left", keyName(KeyEvent.KEYCODE_DPAD_LEFT))
        assertEquals("right", keyName(KeyEvent.KEYCODE_DPAD_RIGHT))
        assertEquals("select", keyName(KeyEvent.KEYCODE_DPAD_CENTER))
        assertEquals("select", keyName(KeyEvent.KEYCODE_ENTER))
        assertEquals("back", keyName(KeyEvent.KEYCODE_BACK))
        assertEquals("playpause", keyName(KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE))
        assertEquals("menu", keyName(KeyEvent.KEYCODE_MENU))
    }

    @Test
    fun unmappedKeysAreNull() {
        assertNull(keyName(KeyEvent.KEYCODE_A))
        assertNull(keyName(KeyEvent.KEYCODE_VOLUME_UP))
    }

    @Test
    fun systemKeysPassThrough() {
        assertTrue(shouldPassToSystem(KeyEvent.KEYCODE_HOME))
        assertTrue(shouldPassToSystem(KeyEvent.KEYCODE_VOLUME_UP))
        assertTrue(shouldPassToSystem(KeyEvent.KEYCODE_VOLUME_DOWN))
        assertTrue(shouldPassToSystem(KeyEvent.KEYCODE_VOLUME_MUTE))
        assertFalse(shouldPassToSystem(KeyEvent.KEYCODE_DPAD_UP))
        assertFalse(shouldPassToSystem(KeyEvent.KEYCODE_BACK))
    }
}
