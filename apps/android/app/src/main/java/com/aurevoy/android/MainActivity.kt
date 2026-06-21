package com.aurevoy.android

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat

/**
 * Aurevoy Android 主界面。
 *
 * 使用 WebView 加载 packages/web-ui 的独立构建产物，
 * 通过 AndroidPlatformAdapter（JavaScriptInterface）桥接原生能力。
 *
 * 架构：
 *   React UI (web-ui bundle)  ←→  AurevoyPlatform (JS bridge)  ←→ Android 原生
 *                                       │
 *                                       ▼
 *                               HTTP + SSE → apps/agent (远程/本地后端)
 */
class MainActivity : ComponentActivity() {

    private lateinit var webView: WebView
    private val agentBaseUrl: String by lazy {
        // 可从 intent extra 或配置文件读取
        intent.getStringExtra("AGENT_BASE_URL") ?: "http://127.0.0.1:8787"
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        webView = WebView(this).also { view ->
            view.settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = true
                allowFileAccess = true
                allowContentAccess = true
                mediaPlaybackRequiresUserGesture = false

                // 现代化 WebView 配置
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    safeBrowsingEnabled = true
                }
                if (Build.VERSION_CODES.LOLLIPOP <= Build.VERSION_CODES.P) {
                    mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
                }
                useWideViewPort = true
                loadWithOverviewMode = true
                builtInZoomControls = false
                displayZoomControls = false
            }

            // 调试模式支持（需 Android 4.4+）
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
                WebView.setWebContentsDebuggingEnabled(true)
            }

            // 注册 JavaScript 桥接
            view.addJavascriptInterface(
                AndroidPlatformAdapter(applicationContext),
                "AurevoyPlatform",
            )
        }

        setContentView(webView)

        // WebChromeClient：处理文件选择器等系统交互
        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(
                view: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?,
            ): Boolean {
                // 创建 ACTION_GET_CONTENT intent 选择文件
                val intent = fileChooserParams?.createIntent() ?: return false
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)

                // 启动 ActivityResultLauncher
                filePickerLauncher.launch(intent)
                pendingFileCallback = filePathCallback
                return true
            }
        }

        // 使用本地 assets 加载 + 网络回退
        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .setDomain("aurevoy.local")
            .build()

        webView.webViewClient = object : WebViewClientCompat() {
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest,
            ): Boolean {
                val url = request.url.toString()
                // 非本地资源 → 让系统浏览器处理
                if (!url.startsWith("https://aurevoy.local/") &&
                    !url.startsWith("file:///android_assets/")
                ) {
                    return false
                }
                return false
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                // 注入 Agent 地址配置
                injectAgentConfig()
            }
        }

        // 加载本地 web-ui 页面
        webView.loadUrl("https://aurevoy.local/assets/web/index.html")
    }

    /** 将 Agent 后端地址注入到 JS 环境变量和 localStorage */
    private fun injectAgentConfig() {
        val prefs = getSharedPreferences("aurevoy_prefs", Context.MODE_PRIVATE)
        val savedUrl = prefs.getString("agentBaseUrl", "")?.ifBlank { null } ?: agentBaseUrl

        val script = """
            window.__AUREVOY_AGENT_BASE_URL__ = "${savedUrl}";
            if (typeof localStorage !== 'undefined') {
                if (!localStorage.getItem('aurevoy.agentBaseUrl')) {
                    localStorage.setItem('aurevoy.agentBaseUrl', '${savedUrl}');
                }
            }
            console.log('[Aurevoy] Agent URL:', '${savedUrl}');
        """.trimIndent()
        webView.evaluateJavascript(script, null)
    }

    /** 处理返回键：先尝试 WebView 回退 */
    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
        } else {
            super.onBackPressed()
        }
    }

    // ---- 文件选择器 (openFileDialog) ----

    private var pendingFileCallback: ValueCallback<Array<Uri>>? = null

    private val filePickerLauncher = registerForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val callback = pendingFileCallback
        pendingFileCallback = null

        if (result.resultCode == RESULT_OK && result.data != null) {
            val uris = mutableListOf<Uri>()

            // 单文件
            result.data?.data?.let { uris.add(it) }

            // 多文件（ClipData）
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN) {
                val clipData = result.data?.clipData
                if (clipData != null) {
                    for (i in 0 until clipData.itemCount) {
                        clipData.getItemAt(i).uri?.let { uris.add(it) }
                    }
                }
            }

            callback?.onReceiveValue(uris.toTypedArray())
        } else {
            callback?.onReceiveValue(null)
        }
    }
}
