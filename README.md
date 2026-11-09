# LocModel 3.1.0 桌面重建版

这是一个可独立编译的 Rust / Tauri 2 项目。Cargo 会把 frontend 目录打入应用。运行界面和本地后端无需原版 LocModel.exe、Node.js 或单独的前端服务器。

## 构建和启动

安装稳定版 Rust 和对应平台的 Tauri 2 编译依赖。macOS 使用 Xcode Command Line Tools，Windows 原生编译使用 MSVC C++ Build Tools、Windows SDK 和 WebView2。Linux 需要 WebKitGTK 4.1、GTK 3 和桌面输入相关开发库。本次实际构建平台为 Apple Silicon macOS，并从该平台交叉编译了 Windows x64 可执行文件。[Tauri 平台准备说明](https://v2.tauri.app/start/prerequisites/)

在包含 Cargo.toml 的目录执行以下命令。第一次构建需要下载 Cargo 依赖。

```sh
cargo run --locked --release
```

Windows 发布包需解压整个目录，保持 locmodel.exe 和 WebView2Loader.dll 在一起。目标系统需要 Microsoft Edge WebView2 Runtime。macOS 发布包供 Apple Silicon 使用，内含本地临时签名，没有开发者公证。

## 运行第一个本地模型

1. 打开概览页。应用会检测 CPU、内存、磁盘和可用的显卡信息。
2. 如果已有 llama-server，应用会从 PATH 查找。在设置里也可以导入解压后的 llama.cpp 引擎目录。环境变量 LOCMODEL_LLAMA_SERVER 支持指定可执行文件。应用内安装功能从 llama.cpp 官方发行包读取 SHA-256 并核对下载。
3. 在“模型 → 已安装”选择 GGUF 文件，或通过 Hugging Face 搜索并下载。导入本地文件会登记路径。删除这一登记会保留用户的源文件。
4. 在“运行”选择模型并启动。后端启动子进程，等待 /health 成功，前端随后通过 /v1/chat/completions 对话。默认仅监听 127.0.0.1。设置里可单独开启局域网访问。[llama.cpp 服务接口](https://github.com/ggml-org/llama.cpp/tree/master/tools/server)

源码包和桌面包均不含推理权重。本地文本推理使用 llama.cpp，画图和视频使用带对应任务接口的 stable-diffusion.cpp sd-server。第三方对话接口需在界面中自行配置。首次访问图像生成功能时，可在界面安装或导入引擎和对应模型。[stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp)

## 恢复依据与代码位置

| 路径 | 内容 |
|---|---|
| frontend/ | 提取的 23 个前端资源。app.js 保留含空格的启动参数，并连接重建的账号接口。updater.js 标明安装包来自官方渠道。 |
| assets/catalog.json、src/media/catalog.json | 从主程序恢复的 16 条文本模型记录、12 组图像和视频模型及 51 条量化记录。目录是 3.1.0 快照。 |
| assets/hardware-probe.ps1、src/hardware.rs | 原版 Windows 探测脚本，以及重写的内存、GPU 和进程监测。 |
| src/models/、src/models.rs | GGUF 元数据、分卷、文件登记、mmproj、推荐、Hugging Face 下载与续传。 |
| src/engine.rs | 引擎安装、命令行参数、进程生命周期、健康检查及崩溃事件。 |
| src/media/、src/media.rs | 图像和视频任务、模型及 LoRA 导入、画布文件、取消和作品历史。 |
| src/agent/、src/agent.rs | 工作区工具、附件、桌面控制、网络检索、第三方 API 流及取消。 |
| src/account.rs | 账号中心、套餐、支付订单、激活码及会员凭据。 |
| src/updater.rs | 平台选择、下载取消、发布清单及文件检查、安装程序交接。 |
| src/lib.rs、src/state.rs | 前端 IPC 分发、应用生命周期、设置持久化。 |

前端 start_model、server_status、server-log 等调用和事件定义了前后端接口。样本的 0x1405703b0 引用了 start_model，src/server.rs 的位置记录、/health 和 llama-server 参数也能在原生样本中定位。重建版用这些证据连接前端和 Rust 实现。原始 Rust 类型、线程实现、显存估算算法和完整构建工程没有随安装包发布。项目中的资源规划和恢复策略是可读的重新实现。

## 功能边界

- 本地聊天、模型管理和模型文件下载可独立运行。可在设置中配置 Hugging Face 镜像。HF 访问令牌仅附加到官方 HTTPS 源的请求。
- 收银台显示账号中心实时提供的套餐和支付方式。桌面测试使用本地账号服务模拟付款确认和激活响应，生产订单、资金结算及凭据签发由官方服务处理。
- 应用自动检查官方发布清单。用户点击下载和安装后，会打开对应平台的官方安装包。将来若要继续使用修改后的 Rust 后端，请自行构建重建版。
- 图像和视频的提交、取消、输出保存和多参考图顺序已用本地协议测试服务验证。尚未用完整扩散模型权重验证实际生成效果。
- 第三方 API 的 SSE 和取消使用本地服务验证。真实服务商密钥、屏幕录制与输入授权、实际多显卡推理均未经实机验证。停止 Agent 推理后，已经启动的 shell 命令可能继续运行到完成或超时。
- 设置和 API 配置保存在平台应用数据目录，应用标识为 local.locmodel.reconstruction。设置中的 API 密钥和令牌保存在本地 JSON 文件。可通过 LOCMODEL_DATA_DIR 指定独立的数据目录。

## 会员、支付与更新

在“设置 → 高速下载”读取套餐、创建订单、扫描二维码或打开支付页。收银台轮询服务端订单状态。待付款或过期订单不能开通会员。已有激活码可直接输入，遗失激活码可请求邮件找回。默认访问官方账号中心；如需测试，可在设置中指定独立服务地址。

更新检查在启动时运行，也可手动触发。发布清单决定目标平台、版本与下载地址。下载和安装分别由用户触发。安装官方版不包含重建版的定制代码，也不保证两个应用的数据目录互通。Windows 便携模式优先使用可写的 LocModelData 目录，并引导用户到便携版下载页。

账号中心的设备标识和已验证令牌按服务地址隔离保存在 account.json。只有服务端明确返回令牌和有效期时才开通会员。原版把显式 expires=0 解释为长期有效，缺少有效期的响应会被拒绝。自定义账号中心使用 HTTPS，本机测试可使用回环 HTTP 地址。会员下载经授权节点发送 X-Launcher-Token；跨域跳转会移除凭据。下载可以断点续传，目前每个文件使用单个 HTTP 数据流。尚未复现原版的多路并发吞吐和低速自动切换。

以下位置可在原版 LocModel.exe 中复核。偏移是文件偏移，虚拟地址标为 VA。

| 原版证据 | 对应行为 |
|---|---|
| 0xdb04eb、0xdb0507 | 按令牌查询有效期、按设备查询会员状态 |
| 0xdb05eb、0xdb059a、0xdb05b0 | 读取套餐、创建订单、按订单号和设备查询结果 |
| 0xdb0632、0xdb0649；VA 0x1405da350 | 找回与激活接口、请求序列化 |
| 0xdb1590 | 加速节点使用的 X-Launcher-Token 请求头 |
| 0xdb2d5e、0xdb2d72；frontend/updater.js | 便携标记、数据目录和更新交互 |

官方公开清单提供版本及分平台安装包地址。若清单没有摘要，程序依赖官方 HTTPS 下载来源，并用下载时计算的 SHA-256 在安装前检查本地文件是否已被改动。该检查无法独立证明发布者签名。

## 验证

```sh
cargo test --locked --lib
cargo test --locked --test desktop
```

第二条命令需要图形会话。它启动真正的 Tauri 窗口，让内嵌前端通过 IPC 读取硬件、目录和设置，并切换页面。本地账号服务还会返回更高版本通知，并模拟下单、待付款、已付款、激活失败与成功、邮件找回。测试不会创建官方订单或调用真实支付。要同时验证真实本地聊天，请将 LOCMODEL_TEST_GGUF 设置为有效的文本模型绝对路径，并准备 llama-server。桌面测试使用临时数据目录。

本机使用 stories260K（1,185,376 字节）完成了导入、加载、聊天接口返回生成 token 和停止引擎的流程。另通过测试镜像进行了联网搜索、下载、解析及移除。Windows 发布程序已完成交叉编译并核对 PE 架构和 WebView2 加载器，尚未在 Windows 桌面会话中运行。
