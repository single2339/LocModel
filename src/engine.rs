use crate::{Ctx, Reply};
use reqwest::blocking::Client;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    env, fs,
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        LazyLock, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};

struct Running {
    child: Child,
    path: String,
    port: u16,
    ready: bool,
    since: Instant,
    last_log: String,
    gpu_error: bool,
}
#[derive(Default)]
struct Service {
    running: Option<Running>,
    crash: Value,
}
static SERVICE: LazyLock<Mutex<Service>> = LazyLock::new(Default::default);
const EXE: &str = if cfg!(windows) {
    "llama-server.exe"
} else {
    "llama-server"
};

fn find_in(dir: &Path, depth: usize) -> Option<PathBuf> {
    if dir.join(EXE).is_file() {
        return Some(dir.join(EXE));
    }
    if depth == 0 {
        return None;
    }
    fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .find_map(|e| find_in(&e.path(), depth - 1))
}
pub fn executable(ctx: &Ctx) -> Option<PathBuf> {
    let saved = ctx.read("engine", Value::Null).ok()?;
    saved["server_path"]
        .as_str()
        .or_else(|| saved.as_str())
        .map(PathBuf::from)
        .into_iter()
        .chain(env::var_os("LOCMODEL_LLAMA_SERVER").map(PathBuf::from))
        .chain(env::split_paths(&env::var_os("PATH").unwrap_or_default()).map(|d| d.join(EXE)))
        .chain(["/opt/homebrew/bin", "/usr/local/bin"].map(|d| Path::new(d).join(EXE)))
        .find(|p| p.is_file())
        .and_then(|p| p.canonicalize().ok())
}
pub fn info(ctx: &Ctx) -> Value {
    let Some(p) = executable(ctx) else {
        return Value::Null;
    };
    if let Ok(v) = ctx.read("engine", Value::Null) {
        if v["server_path"].as_str().map(Path::new) == Some(&p) {
            return v;
        }
    }
    json!({"server_path":p,"variant":"auto","tag":"系统引擎"})
}
fn register(ctx: &Ctx, path: PathBuf, tag: &str, variant: &str) -> Reply {
    ctx.write("engine",&json!({"server_path":path.canonicalize().map_err(|e|e.to_string())?,"tag":tag,"variant":variant}))?;
    Ok(info(ctx))
}
fn install_archive(ctx: &Ctx, file: &Path, zip: bool, tag: &str, variant: &str) -> Reply {
    let root = ctx.root.join("engines");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let temp = tempfile::tempdir_in(root).map_err(|e| e.to_string())?;
    let input = fs::File::open(file).map_err(|e| e.to_string())?;
    if zip {
        zip::ZipArchive::new(input)
            .map_err(|e| e.to_string())?
            .extract(temp.path())
            .map_err(|e| e.to_string())?;
    } else {
        tar::Archive::new(flate2::read::GzDecoder::new(input))
            .unpack(temp.path())
            .map_err(|e| e.to_string())?;
    }
    let path = find_in(temp.path(), 4).ok_or("压缩包里没有 llama-server")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    }
    let result = register(ctx, path, tag, variant)?;
    let _ = temp.keep();
    Ok(result)
}
static CANCEL: AtomicBool = AtomicBool::new(false);
static INSTALL: Mutex<()> = Mutex::new(());
fn install(ctx: &Ctx, app: &AppHandle, force: bool) -> Reply {
    let _lock = INSTALL.lock().unwrap();
    CANCEL.store(false, Ordering::Release);

    let pattern = match (env::consts::OS, env::consts::ARCH) {
        ("macos", "aarch64") => "bin-macos-arm64",
        ("macos", "x86_64") => "bin-macos-x64",
        ("windows", "x86_64") if ctx.settings()?["engine_cpu"] != true => "bin-win-vulkan-x64",
        ("windows", "x86_64") => "bin-win-cpu-x64",
        ("linux", "x86_64") => "bin-ubuntu-x64",
        _ => return Err("请从设置导入适合本平台的 llama.cpp 引擎目录".into()),
    };
    let client = Client::builder()
        .user_agent("LocModel-reconstruction")
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;
    let releases: Value = client
        .get("https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=4")
        .send()
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.json())
        .map_err(|e| e.to_string())?;
    let (tag, asset) = releases
        .as_array()
        .into_iter()
        .flatten()
        .find_map(|rel| {
            let asset = rel["assets"].as_array()?.iter().find(|a| {
                a["name"].as_str().is_some_and(|n| {
                    n.starts_with("llama-")
                        && n.contains(pattern)
                        && (n.ends_with(".zip") || n.ends_with(".tar.gz"))
                })
            })?;
            Some((rel["tag_name"].as_str()?, asset))
        })
        .ok_or("当前发行版无适配包，请导入引擎目录")?;
    let variant = if pattern.contains("vulkan") {
        "vulkan"
    } else if pattern.contains("macos") {
        "metal"
    } else {
        "cpu"
    };
    let current = info(ctx);
    if !force && current["tag"] == tag && current["variant"] == variant {
        return Ok(current);
    }
    let official = asset["browser_download_url"]
        .as_str()
        .ok_or("发行包缺少地址")?;
    let cfg = ctx.settings()?;
    let prefix = cfg["github_mirror"]
        .as_str()
        .unwrap_or("")
        .trim_end_matches('/');
    let url = if prefix.is_empty() {
        official.to_owned()
    } else {
        format!("{prefix}/{official}")
    };
    let expected = asset["digest"]
        .as_str()
        .and_then(|s| s.strip_prefix("sha256:"))
        .ok_or("GitHub 没有提供发行包 SHA-256")?;
    let mut digest = Sha256::new();
    let mut archive = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
    let mut body = client
        .get(&url)
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| e.to_string())?;
    let total = body.content_length();
    let mut done = 0;
    let mut last = Instant::now();
    let began = Instant::now();
    let mut buf = [0; 65536];
    loop {
        if CANCEL.load(Ordering::Acquire) {
            return Err("安装下载已取消".into());
        }
        let n = body.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        digest.update(&buf[..n]);
        archive.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        done += n as u64;
        if last.elapsed() > Duration::from_millis(250) {
            let _=app.emit("download-progress",json!({"id":"engine","status":"downloading","done":done,"total":total,"speed":done as f64/began.elapsed().as_secs_f64(),"file_index":0,"file_count":1}));
            last = Instant::now();
        }
    }
    if total.is_some_and(|size| size != done) {
        return Err("引擎包下载不完整".into());
    }
    if format!("{:x}", digest.finalize()) != expected {
        return Err("引擎包 SHA-256 校验失败".into());
    }
    install_archive(ctx, archive.path(), url.ends_with(".zip"), tag, variant)
}
fn status(s: &Service) -> Value {
    match s.running.as_ref() {
        None => json!({"running":false,"ready":false}),
        Some(r) => {
            json!({"running":true,"ready":r.ready,"model_path":r.path,"model_name":Path::new(&r.path).file_stem(),"port":r.port})
        }
    }
}
pub fn stop() {
    if let Some(mut r) = SERVICE.lock().unwrap().running.take() {
        let _ = r.child.kill();
        let _ = r.child.wait();
    }
}
pub fn pid() -> Option<u32> {
    SERVICE
        .lock()
        .unwrap()
        .running
        .as_ref()
        .map(|r| r.child.id())
}
fn log_pipe(pipe: impl Read + Send + 'static, app: AppHandle, pid: u32) {
    thread::spawn(move || {
        for line in BufReader::new(pipe).lines().map_while(Result::ok) {
            let mut s = SERVICE.lock().unwrap();
            let Some(r) = s.running.as_mut().filter(|r| r.child.id() == pid) else {
                break;
            };
            let lower = line.to_ascii_lowercase();
            r.gpu_error |= [
                "cuda error",
                "metal error",
                "vulkan error",
                "out of device memory",
                "ggml_cuda_error",
            ]
            .iter()
            .any(|s| lower.contains(s));
            r.last_log = line.clone();
            drop(s);
            let _ = app.emit("server-log", line);
        }
    });
}
fn monitor(pid: u32, app: AppHandle) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(500));
        let mut s = SERVICE.lock().unwrap();
        let Some(r) = s.running.as_mut().filter(|r| r.child.id() == pid) else {
            break;
        };
        let Ok(Some(exit)) = r.child.try_wait() else {
            continue;
        };
        s.crash = json!({"model_path":r.path,"gpu_error":r.gpu_error,"message":format!("llama-server {exit}\n{}",r.last_log)});
        s.running = None;
        let crash = s.crash.clone();
        let st = status(&s);
        drop(s);
        let _ = app.emit("server-status", st);
        let _ = app.emit("server-crashed", crash);
        break;
    });
}
fn custom(input: &str) -> Result<(Vec<String>, Vec<String>), String> {
    let tokens = shell_words::split(input).map_err(|e| e.to_string())?;
    let mut it = tokens.into_iter();
    let mut keep = Vec::new();
    let mut dropped = Vec::new();
    while let Some(t) = it.next() {
        let flag = t.split('=').next().unwrap();
        if matches!(flag, "-m" | "--model" | "--mmproj" | "--host" | "--port") {
            let paired = !t.contains('=');
            dropped.push(t);
            if paired {
                if let Some(v) = it.next() {
                    dropped.push(v)
                }
            }
        } else {
            keep.push(t);
        }
    }
    Ok((keep, dropped))
}
pub fn launch_args(
    cfg: &Value,
    path: &str,
    ctx_size: u64,
    port: u16,
    level: u64,
    mmproj: Option<&str>,
    custom_args: &str,
) -> Result<Vec<String>, String> {
    let (extra, _) = custom(custom_args)?;
    let has = |names: &[&str]| {
        extra
            .iter()
            .any(|s| names.contains(&s.split('=').next().unwrap()))
    };
    let host = if cfg["lan_access"] == true {
        "0.0.0.0"
    } else {
        "127.0.0.1"
    };
    let mut args = vec![
        "-m".into(),
        path.into(),
        "--host".into(),
        host.into(),
        "--port".into(),
        port.to_string(),
    ];
    if !has(&["-c", "--ctx-size"]) {
        args.extend(["-c".into(), ctx_size.to_string()]);
    }
    if cfg["engine_cpu"] == true && !has(&["-ngl", "--gpu-layers", "--n-gpu-layers"]) {
        args.extend(["-ngl".into(), "0".into()]);
    }
    if let Some(devices) = cfg["gpu_devices"]
        .as_array()
        .filter(|v| !v.is_empty() && cfg["engine_cpu"] != true)
    {
        if !has(&["-dev", "--device"]) {
            args.extend([
                "--device".into(),
                devices
                    .iter()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(","),
            ]);
        }
    }
    let fa = cfg["perf_fa"] != "off" && level < 2;
    if !has(&["-fa", "--flash-attn"]) {
        args.extend(["-fa".into(), if fa { "on" } else { "off" }.into()]);
    }
    let kv = if level >= 1 {
        "f16"
    } else {
        cfg["perf_kv"].as_str().unwrap_or("f16")
    };
    if !has(&["-ctk", "--cache-type-k"]) {
        args.extend(["-ctk".into(), kv.into()]);
    }
    if !has(&["-ctv", "--cache-type-v"]) {
        args.extend(["-ctv".into(), if fa { kv } else { "f16" }.into()]);
    }
    if level >= 5 {
        args.extend(["-b".into(), "128".into(), "-ub".into(), "64".into()]);
    }
    if let Some(p) = mmproj.filter(|p| !p.is_empty() && level < 4) {
        args.extend(["--mmproj".into(), p.into()]);
    }
    args.extend(extra);
    Ok(args)
}
fn start(ctx: &Ctx, app: &AppHandle, a: &Value) -> Reply {
    let path = a["path"].as_str().ok_or("缺少模型路径")?;
    let model = crate::models::lookup(ctx, path)?;
    let exe = executable(ctx).ok_or("尚未安装 llama.cpp，请先安装或导入引擎")?;
    let cfg = ctx.settings()?;
    let preferred = cfg["port"].as_u64().unwrap_or(8686) as u16;
    let levels = ctx.read("safe_levels", json!({}))?;
    let level = a["safe"]
        .as_u64()
        .or_else(|| levels[path].as_u64())
        .unwrap_or(0)
        .min(5);
    let len = a["ctx"]
        .as_u64()
        .filter(|v| *v > 0)
        .unwrap_or_else(|| model["plan"]["ctx"].as_u64().unwrap_or(4096));
    let saved = ctx.read("custom_args", json!({}))?;
    custom(saved[path].as_str().unwrap_or(""))?;
    stop();
    let mut s = SERVICE.lock().unwrap();
    if s.running.is_some() {
        return Err("请先停止当前运行的模型".into());
    }
    let port = (preferred..=preferred.saturating_add(100))
        .find(|n| TcpListener::bind(("127.0.0.1", *n)).is_ok())
        .ok_or("没有可用端口")?;
    let mut cmd = Command::new(exe);
    let mm = model["mmproj"]
        .as_str()
        .filter(|p| !p.is_empty() && level < 4);
    let args = launch_args(
        &cfg,
        path,
        len,
        port,
        level,
        mm,
        saved[path].as_str().unwrap_or(""),
    )?;
    crate::media::stop();
    if level >= 3 {
        cmd.env("GGML_CUDA_DISABLE_GRAPHS", "1");
    }
    let mut child = cmd
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动 llama-server 失败：{e}"))?;
    let id = child.id();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    s.running = Some(Running {
        child,
        path: path.into(),
        port,
        ready: false,
        since: Instant::now(),
        last_log: String::new(),
        gpu_error: false,
    });
    s.crash = Value::Null;
    let _ = app.emit("server-status", status(&s));
    drop(s);
    log_pipe(stdout, app.clone(), id);
    log_pipe(stderr, app.clone(), id);
    let http = Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| e.to_string())?;
    let until = Instant::now() + Duration::from_secs(600);
    loop {
        let healthy = http
            .get(format!("http://127.0.0.1:{port}/health"))
            .send()
            .is_ok_and(|r| r.status().is_success());
        let mut s = SERVICE.lock().unwrap();
        let r = s
            .running
            .as_mut()
            .filter(|r| r.child.id() == id)
            .ok_or("模型启动已取消")?;
        if let Some(exit) = r.child.try_wait().map_err(|e| e.to_string())? {
            let err = format!("加载模型失败（{exit}）：{}", r.last_log);
            s.crash = json!({"message":err,"model_path":path,"gpu_error":r.gpu_error});
            s.running = None;
            let _ = app.emit("server-status", status(&s));
            return Err(err);
        }
        if healthy {
            r.ready = true;
            let _ = app.emit("server-status", status(&s));
            drop(s);
            monitor(id, app.clone());
            ctx.update("safe_levels", json!({}), |v| {
                v[path] = json!(level);
                Ok(())
            })?;
            return Ok(
                json!({"ctx":len,"safe_level":level,"vision":mm.is_some(),"model_repo":model["repo"],"vision_off":if mm.is_some(){Value::Null}else if model["mmproj"].is_string(){json!("safe")}else{json!("none")}}),
            );
        }
        if Instant::now() >= until {
            let _ = r.child.kill();
            let _ = r.child.wait();
            s.running = None;
            let _ = app.emit("server-status", status(&s));
            return Err("引擎加载超时".into());
        }
        drop(s);
        thread::sleep(Duration::from_millis(200));
    }
}
fn check_engine(ctx: &Ctx) -> Reply {
    let exe = executable(ctx).ok_or("未检测到引擎")?;
    let output = Command::new(exe)
        .arg("--list-devices")
        .output()
        .map_err(|e| e.to_string())?;
    let devices = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let gpus: Vec<_> = devices
        .lines()
        .filter_map(|line| {
            let (id, tail) = line.trim().split_once(": ")?;
            if !tail.contains("MiB") || id.contains(char::is_whitespace) {
                return None;
            }
            let (name, capacity) = tail.rsplit_once(" (")?;
            let mib = capacity.split_whitespace().next()?.parse::<u64>().ok();
            Some(json!({"id":id,"name":name,"mib":mib}))
        })
        .collect();
    Ok(
        json!({"bad_arch":[],"unknown":!output.status.success(),"gpu_ok":!gpus.is_empty(),"devices":devices,"gpus":gpus}),
    )
}
fn save_args(ctx: &Ctx, a: &Value) -> Reply {
    let path = a["path"].as_str().ok_or("缺少路径")?;
    let (kept, dropped) = custom(a["args"].as_str().unwrap_or(""))?;
    ctx.update("custom_args", json!({}), |m| {
        m[path] = json!(shell_words::join(kept));
        Ok(())
    })?;
    Ok(json!(dropped))
}
fn import_directory(ctx: &Ctx) -> Reply {
    let Some(dir) = rfd::FileDialog::new().pick_folder() else {
        return Ok(Value::Null);
    };
    let file = find_in(&dir, 3).ok_or("未找到 llama-server")?;
    register(ctx, file, "手动导入", "auto")
}
pub fn handle(cmd: &str, a: &Value, ctx: &Ctx, app: &AppHandle) -> Option<Reply> {
    Some(match cmd {
        "cancel_download" if a["id"] == "engine" => {
            CANCEL.store(true, Ordering::Release);
            Ok(Value::Null)
        }
        "install_engine" => install(ctx, app, a["force"].as_bool().unwrap_or(false)),
        "import_engine_zip" => match rfd::FileDialog::new()
            .add_filter("llama.cpp", &["zip"])
            .pick_file()
        {
            Some(p) => install_archive(ctx, &p, true, "手动导入", "auto"),
            None => Ok(Value::Null),
        },
        "import_engine_dir" => import_directory(ctx),
        "server_status" => Ok(status(&SERVICE.lock().unwrap())),
        "start_model" => start(ctx, app, a),
        "stop_model" => {
            stop();
            let _ = app.emit("server-status", status(&SERVICE.lock().unwrap()));
            Ok(Value::Null)
        }
        "last_crash" => Ok(SERVICE.lock().unwrap().crash.clone()),
        "load_progress" => {
            let s = SERVICE.lock().unwrap();
            Ok(match &s.running {
                Some(r) => {
                    json!({"running":true,"stage":if r.ready{"已就绪"}else{"读取模型权重"},"fraction":-1,"elapsed_s":r.since.elapsed().as_secs(),"last_log":r.last_log})
                }
                None => json!({"running":false}),
            })
        }
        "engine_check" => check_engine(ctx),
        "set_custom_args" => save_args(ctx, a),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn engine_manages_port_model_and_vision_once() {
        let args = launch_args(
            &json!({"lan_access":false}),
            "/tmp/my model",
            4096,
            9000,
            4,
            Some("vision file"),
            "--host=0.0.0.0 -m injected --mmproj bad --ctx-size 512",
        )
        .unwrap();
        assert!(!args
            .iter()
            .any(|a| ["injected", "bad", "0.0.0.0", "-c", "--mmproj"].contains(&a.as_str())));
        assert_eq!(args.iter().filter(|a| *a == "--ctx-size").count(), 1);
        assert!(args.iter().any(|s| s == "/tmp/my model"));
    }
}
