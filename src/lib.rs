mod account;
mod agent;
mod engine;
mod hardware;
mod media;
mod models;
mod state;
mod updater;

use serde_json::{json, Value};
pub use state::Ctx;
use std::{
    env,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, Manager};
pub type Reply = Result<Value, String>;
static START: Mutex<()> = Mutex::new(());

fn autostart(cmd: &str, on: bool) -> Reply {
    let exe = env::current_exe().map_err(|e| e.to_string())?;
    let launcher = auto_launch::AutoLaunchBuilder::new()
        .set_app_name("LocModel Reconstruction")
        .set_app_path(exe.to_str().ok_or("程序路径编码无效")?)
        .set_use_launch_agent(true)
        .build()
        .map_err(|e| e.to_string())?;
    if cmd == "set_autostart" {
        if on {
            launcher.enable()
        } else {
            launcher.disable()
        }
        .map_err(|e| e.to_string())?;
    }
    launcher
        .is_enabled()
        .map(Value::Bool)
        .map_err(|e| e.to_string())
}
fn url(s: &str) -> Result<reqwest::Url, String> {
    let u = reqwest::Url::parse(s).map_err(|e| e.to_string())?;
    if !matches!(u.scheme(), "https" | "http") {
        return Err("仅支持 HTTP 或 HTTPS 地址".into());
    }
    Ok(u)
}
fn dispatch(cmd: &str, a: &Value, ctx: &Ctx, app: &AppHandle) -> Reply {
    let _start = if matches!(cmd, "start_model" | "start_image") {
        Some(START.lock().unwrap())
    } else {
        None
    };
    for module in [
        updater::handle,
        account::handle,
        engine::handle,
        models::handle,
        media::handle,
        agent::handle,
    ] {
        if let Some(reply) = module(cmd, a, ctx, app) {
            return reply;
        }
    }
    match cmd {
        "get_settings" => account::settings(ctx),
        "save_settings" => {
            let mut s = a
                .get("settings")
                .filter(|v| v.is_object())
                .cloned()
                .ok_or("设置必须是对象")?;
            if let Some(base) = s.get("account_base") {
                account::validate_base(base.as_str().ok_or("账号地址必须是字符串")?)?;
            }
            if let Some(port) = s.get("port") {
                if !port.as_u64().is_some_and(|p| (1024..=65535).contains(&p)) {
                    return Err("端口必须在 1024–65535 之间".into());
                }
            }
            if let Some(dir) = s["models_dir"].as_str().filter(|s| !s.is_empty()) {
                if !Path::new(dir).is_absolute() {
                    return Err("模型目录必须是绝对路径".into());
                }
                std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            } else {
                s["models_dir"] = json!(ctx.root.join("models"));
            }
            // Only the verified account response may change entitlement or identity.
            // Keep legacy fields on disk for migration when saving unrelated settings.
            let fields = s.as_object_mut().unwrap();
            for key in ["device_id", "member_token", "member_expires", "buy_email"] {
                fields.remove(key);
            }
            ctx.update("settings", json!({}), |settings| {
                settings
                    .as_object_mut()
                    .ok_or("settings.json 格式错误")?
                    .extend(fields.clone());
                Ok(())
            })?;
            account::settings(ctx)
        }
        "get_overview" => hardware::overview(ctx),
        "live_stats" | "sys_monitor" => Ok(hardware::monitor()),
        "get_autostart" | "set_autostart" => autostart(cmd, a["on"].as_bool().unwrap_or(false)),
        "set_window_theme" => {
            let theme = match a["theme"].as_str() {
                Some("dark") => Some(tauri::Theme::Dark),
                Some("light") => Some(tauri::Theme::Light),
                _ => None,
            };
            app.set_theme(theme);
            Ok(Value::Null)
        }
        "open_url" => {
            let u = url(a["url"].as_str().ok_or("缺少链接")?)?;
            open::that(u.as_str()).map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "open_path" => {
            let p = Path::new(a["path"].as_str().ok_or("缺少路径")?);
            if !p.exists() {
                return Err("路径不存在".into());
            }
            open::that(p).map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        "pick_folder" => Ok(json!(rfd::FileDialog::new().pick_folder())),
        "make_qr" => {
            let qr = qrcode::QrCode::new(a["text"].as_str().ok_or("缺少二维码内容")?)
                .map_err(|e| e.to_string())?;
            Ok(json!(qr.render::<qrcode::render::svg::Color>().build()))
        }
        "refresh_membership" => account::restore(ctx),
        "ping_servers" => models::ping_servers(ctx),
        "close_pay_window" => Ok(Value::Null),
        _ => Err(format!("重建版尚未实现命令 {cmd}")),
    }
}
pub fn builder() -> tauri::Builder<tauri::Wry> {
    tauri::Builder::default()
        .setup(|app| {
            let root = env::var_os("LOCMODEL_DATA_DIR")
                .map(PathBuf::from)
                .or_else(updater::portable_root)
                .unwrap_or(app.path().app_data_dir()?);
            app.manage(Ctx::new(root)?);
            Ok(())
        })
        .invoke_handler(|invoke| {
            let command = invoke.message.command().to_string();
            let app = invoke.message.webview().app_handle().clone();
            let tauri::ipc::InvokeBody::Json(args) = invoke.message.payload() else {
                invoke.resolver.reject("仅支持 JSON 参数");
                return true;
            };
            let args = args.clone();
            invoke.resolver.respond_async(async move {
                tauri::async_runtime::spawn_blocking(move || {
                    dispatch(&command, &args, &app.state::<Ctx>(), &app)
                })
                .await
                .map_err(|e| tauri::ipc::InvokeError::from(e.to_string()))?
                .map_err(Into::into)
            });
            true
        })
}
pub fn shutdown() {
    agent::shutdown();
    engine::stop();
    media::stop();
}
