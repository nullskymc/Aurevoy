package com.aurevoy.android

import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.net.Uri
import android.webkit.JavascriptInterface
import android.webkit.MimeTypeMap
import java.io.File

/**
 * Aurevoy PlatformAdapter 的 Android 实现。
 *
 * 通过 @JavascriptInterface 暴露给 WebView 中的 JavaScript 代码。
 * 注册为 window.AurevoyPlatform 对象。
 *
 * 同步方法：
 * - filePathToUrl(path) → string | null
 * - openExternal(url) → void
 *
 * 异步方法（通过回调）：
 * - openFileDialog(jsonOptions, callbackId) → void
 */
class AndroidPlatformAdapter(private val context: Context) {

    /** 将文件系统路径转为 WebView 可加载的 content:// URI */
    @JavascriptInterface
    fun filePathToUrl(filePath: String): String? {
        return try {
            val file = File(filePath)
            if (file.exists()) {
                val uri = Uri.fromFile(file).toString()
                uri
            } else {
                // 可能是 content:// URI
                val uri = Uri.parse(filePath)
                if (uri.scheme == "content") filePath else null
            }
        } catch (_: Exception) {
            null
        }
    }

    /** 在系统浏览器中打开外部链接 */
    @JavascriptInterface
    fun openExternal(url: String) {
        try {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
        } catch (_: Exception) {
            // 忽略：没有浏览器可处理该 URL
        }
    }

    /** 获取文件的 MIME 类型（供 JS 调用） */
    @JavascriptInterface
    fun getMimeType(filePath: String): String {
        val extension = filePath.substringAfterLast('.', "")
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension.lowercase())
            ?: "application/octet-stream"
    }

    /** 检查文件是否存在 */
    @JavascriptInterface
    fun fileExists(filePath: String): Boolean {
        return try {
            val file = File(filePath)
            file.exists() && file.isFile
        } catch (_: Exception) {
            false
        }
    }

    /** 获取保存的 Agent 后端地址 */
    @JavascriptInterface
    fun getAgentUrl(): String {
        val prefs: SharedPreferences =
            context.getSharedPreferences("aurevoy_prefs", Context.MODE_PRIVATE)
        return prefs.getString("agentBaseUrl", "") ?: ""
    }

    /** 保存 Agent 后端地址。由设置页调用。 */
    @JavascriptInterface
    fun setAgentUrl(url: String) {
        val prefs: SharedPreferences =
            context.getSharedPreferences("aurevoy_prefs", Context.MODE_PRIVATE)
        prefs.edit().putString("agentBaseUrl", url).apply()
    }
}
