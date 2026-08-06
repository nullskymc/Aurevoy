# Windows 分发与代码签名预审

> 适用版本：Aurevoy v0.7.0 及后续 0.7.x。本文记录公开分发前的技术选型与验收门槛，不代表当前版本已经完成 Windows 签名发布。

## 当前结论

公开分发默认优先评估 Azure Artifact Signing；如果组织、地区或身份条件不满足，再采用 Windows 兼容的 OV 代码签名证书和受控 CI 密钥托管。Microsoft Store 的 MSIX 分发是独立路线，商店会重新签名，不能替代 GitHub Releases 的安装器签名。

当前仓库没有提交证书、PFX、私钥或服务令牌。v0.7.0 仍未宣称 Windows 签名和 SmartScreen 声誉门已经通过。

## 方案比较（2026-08-07 预审快照）

| 方案 | 成本/限制 | CI 接入与密钥边界 | 适用场景 |
|---|---|---|---|
| Azure Artifact Signing | 官方 SKU 页面列出 Basic 为 `$9.99/月`、每月 5,000 次签名；Premium 为 `$99.99/月`、每月 100,000 次签名，超额按次计费。需要满足地区、身份和服务资格。 | 由签名服务托管密钥，CI 使用短期身份凭据；仓库不保存私钥。 | GitHub Releases 的长期默认候选。 |
| OV 代码签名证书 | 证书价格随 CA、期限和购买渠道变化；Microsoft 的选型页给出约 `$150–300/年` 的 OV 量级，需以实际 CA 报价为准。 | 可用受保护的证书服务或 CI secret；若使用 PFX，必须短期注入 runner、签后清理，并配置时间戳。 | Artifact Signing 不可用时的回退。 |
| EV 代码签名证书 | 成本更高，且 SmartScreen 不应按“购买 EV 即立即消除警告”规划；仍需积累发布声誉。 | 同 OV，优先硬件/托管密钥，不在仓库保存私钥。 | 只有发行商有明确合规和预算需求时评估。 |
| Microsoft Store MSIX | 商店分发链路由 Store 处理签名；用户获取路径、审核和更新机制与 GitHub Releases 不同。 | 使用 Store 的发布凭据和打包流程，不能直接复用为 GitHub 安装器签名。 | 需要 Store 发现、安装和更新能力时。 |

官方页面：

- [Microsoft：Windows code signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)
- [Microsoft：Azure Artifact Signing SKU](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-change-sku)
- [Microsoft：SignTool](https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool)
- [Tauri：Windows code signing](https://v2.tauri.app/distribute/sign/windows/)

价格、地区资格、证书政策和服务名称可能变化；发布前必须重新核对官方页面及组织的实际报价。

## 推荐的 CI 形态

Windows runner 上的发布 job 应按以下边界组织：

1. 构建 Tauri Windows 产物，并记录 NSIS 安装器、主程序和更新元数据的实际路径。
2. 通过 Artifact Signing 或受控证书服务完成签名；证书、私钥、服务令牌只来自 GitHub Actions secrets/OIDC 或服务端密钥托管。
3. 对最终交付物执行签名链、时间戳和发布者校验；至少覆盖安装器和主程序，不只验证中间构建文件。
4. 只上传验证通过的产物和 `latest.json`；签名失败时 job 必须失败，不允许降级为未签名上传。

若采用 PFX/SignTool 路线，验证命令形态如下（实际证书参数和时间戳服务由发行商确定）：

```powershell
signtool verify /pa /all /tw /v .\Aurevoy-Setup.exe
signtool verify /pa /all /tw /v .\Aurevoy.exe
```

签名阶段应使用 SHA-256 摘要和 RFC 3161 时间戳，并在 job 结束时清理临时证书文件。`signtool verify /pa` 的验证结果应作为发布门，而不是只检查命令是否执行。

仓库的发布工作流已提供 `scripts/sign-windows-release.ps1`：非 tag 构建没有证书时只给出 warning；v* tag 发布没有 WINDOWS_CODE_SIGNING_CERT_BASE64 时直接失败。证书由 Secret 以 base64 形式注入 runner，脚本不会把 PFX 写入仓库或上传到 artifact。

安装、升级和卸载可在带桌面会话的 Windows 测试机上用 `scripts/windows-install-smoke.ps1` 固定执行。它要求同时提供旧版和新版 NSIS 安装器，使用同一临时安装目录依次静默安装、启动并关闭、升级、再次启动并卸载；脚本会比较主程序 SHA-256、记录版本与签名状态，并输出 JSON 报告：

```powershell
pwsh -File .\scripts\windows-install-smoke.ps1 `
  -InstallerPath .\Aurevoy-previous-Setup.exe `
  -UpgradeInstallerPath .\Aurevoy-current-Setup.exe `
  -RequireSignature `
  -ReportPath .\windows-install-smoke.json
```

该脚本不会把“SmartScreen 首次信誉提示”伪装成自动化通过；报告会明确标记为需要在普通用户的干净 Windows 会话中人工观察。
仓库还提供手动触发的 `.github/workflows/windows-install-smoke.yml`：输入旧版和当前版已发布 tag 后，它会在 Windows runner 下载两个 NSIS 安装器并上传 JSON 报告。

## 尚未通过的 Windows 验收门

以下项目必须在真实 Windows runner 或 Windows 测试机完成后，才能把路线图中的对应条目改为完成：

- Windows WebView2 在干净环境启动，首次安装、已安装升级和卸载均通过。
- Tauri 安装器、主程序、更新产物都能验证签名链、时间戳和发布者。
- 普通用户账户在 SmartScreen、UAC、杀毒软件和代理环境下完成安装/更新；记录首次发布声誉的实际表现。
- Windows Job Object/进程树隔离与 bash 的 `auto|required|process` 策略已实现并纳入 Windows strict CI；仍需在真实 Windows runner 上保留一次成功日志作为发布证据。
- GitHub Actions 的密钥托管、失败即阻断上传、日志脱敏和产物追溯完成演练。

这些门通过前，路线图可以记录“方案已审计”，但不能宣称“Windows 公开分发已完成”。

## 证书续期、轮换与紧急撤销

- 证书到期前至少 30 天在 Secret 管理处登记新旧证书指纹、有效期、签名服务和责任人；不把私钥或 PFX 写入 issue、日志或仓库。
- 轮换时先将新证书写入独立 Secret，使用 workflow dispatch 在非公开渠道完成签名/验证，再切换发布 job；确认旧证书仍可验证历史产物后再删除旧 Secret。
- 发现私钥泄露、签名服务身份泄露或供应商撤销通知时，立即禁用对应 Secret、向 CA/签名服务发起撤销，并暂停 Release；随后用新证书重新生成需要发布的安装器和更新清单。
- 保留公开证书链、指纹、撤销时间和受影响版本的审计记录，不保存私钥、PFX 密码或完整 CI 环境。
