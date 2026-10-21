package com.maanavkrishna.cadabra

import android.annotation.SuppressLint
import android.app.Activity
import android.os.Bundle
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader

class MainActivity : Activity() {
    private lateinit var webView: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            setBackgroundColor(0xFF000000.toInt())
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(
                    view: WebView,
                    request: WebResourceRequest,
                ): WebResourceResponse? = loader.shouldInterceptRequest(request.url)
            }
            webChromeClient = object : WebChromeClient() {
                override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                    Log.i("CadabraWeb", "${m.message()} (${m.sourceId()}:${m.lineNumber()})")
                    return true
                }
            }
        }
        setContentView(webView)
        hideSystemUi()
        webView.loadUrl(START_URL)
    }

    override fun onPause() {
        webView.onPause()
        webView.pauseTimers()
        super.onPause()
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
        webView.resumeTimers()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemUi()
    }

    @Suppress("DEPRECATION")
    private fun hideSystemUi() {
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_FULLSCREEN or
            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION or
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE or
            View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN or
            View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (shouldPassToSystem(event.keyCode)) return super.dispatchKeyEvent(event)
        // Only act on key-down; swallow key-up so the system never sees it either.
        if (event.action != KeyEvent.ACTION_DOWN || event.repeatCount > 0 && event.keyCode == KeyEvent.KEYCODE_BACK) {
            return true
        }
        val name = keyName(event.keyCode) ?: return true
        val js = "(function(){try{if(typeof window.cadabraKey!=='function')return 'missing';" +
            "var r=window.cadabraKey('$name');return r==='exit'?'exit':'handled';}" +
            "catch(e){return 'error';}})()"
        webView.evaluateJavascript(js) { result ->
            // Back contract: JS returns "exit" to leave; a missing bridge, a throw or a WebView
            // failure also finish so the user is never stuck. Anything else stays.
            if (name == "back" && backShouldExit(result)) finish()
        }
        return true
    }

    override fun onDestroy() {
        (webView.parent as? ViewGroup)?.removeView(webView)
        webView.destroy()
        super.onDestroy()
    }

    companion object {
        const val START_URL = "https://appassets.androidplatform.net/assets/www/index.html"
    }
}
