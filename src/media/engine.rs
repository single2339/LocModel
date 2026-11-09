use super::*;
use std::{
    io::Read,
    net::TcpListener,
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};
use tauri::Emitter;

struct Running {
    child: Child,
    id: String,
    quant: String,
    port: u16,
    ready: bool,
}
static RUN: Mutex<Option<Running>> = Mutex::new(None);
static JOB: Mutex<()> = Mutex::new(());
static CANCEL: AtomicU64 = AtomicU64::new(0);
static INSTALL: Mutex<()> = Mutex::new(());
const BIN: &str = if cfg!(windows) {
    "sd-server.exe"
} else {
    "sd-server"
};
pub fn pid() -> Option<u32> {
    RUN.lock().ok()?.as_ref().map(|st| st.child.id())
}
pub fn stop() {
    CANCEL.fetch_add(1, Ordering::SeqCst);
    if let Some(mut state) = RUN.lock().unwrap().take() {
        let _ = state.child.kill();
        let _ = state.child.wait();
    }
}
fn status() -> Reply {
    let mut run = RUN.lock().map_err(err)?;
    if let Some(st) = run.as_mut() {
        if st.child.try_wait().map_err(err)?.is_none() {
            return Ok(
                json!({"running":true,"ready":st.ready,"model":st.id,"quant":st.quant,"port":st.port}),
            );
        }
        *run = None;
    }
    Ok(json!({"running":false,"ready":false}))
}
fn info(ctx: &Ctx) -> Reply {
    let v = ctx.read("image_engine", Value::Null)?;
    if Path::new(s(&v, "server_path")).is_file() {
        Ok(v)
    } else {
        Ok(Value::Null)
    }
}
fn logs(ctx: &Ctx) -> Vec<String> {
    use std::io::{Seek, SeekFrom};
    let Ok(mut f) = fs::File::open(ctx.root.join("sd-server.log")) else {
        return vec![];
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let _ = f.seek(SeekFrom::Start(len.saturating_sub(65536)));
    let mut data = Vec::new();
    let _ = f.read_to_end(&mut data);
    String::from_utf8_lossy(&data)
        .lines()
        .rev()
        .take(240)
        .map(str::to_owned)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}
fn start(ctx: &Ctx, a: &Value) -> Reply {
    let old = status()?;
    if old["ready"] == true && old["model"] == a["id"] && old["quant"] == a["quant"] {
        return Ok(old);
    }
    let (m, q) = catalog::selection(ctx, s(a, "id"), s(a, "quant"))?;
    let engine = info(ctx)?;
    let bin = Path::new(s(&engine, "server_path"));
    if !bin.is_file() {
        return Err("请先安装画图引擎".into());
    }
    let listener = TcpListener::bind("127.0.0.1:0").map_err(err)?;
    let port = listener.local_addr().map_err(err)?.port();
    let mut cmd = Command::new(bin);
    cmd.current_dir(bin.parent().ok_or("引擎路径无效")?).args([
        "--listen-ip",
        "127.0.0.1",
        "--listen-port",
        &port.to_string(),
    ]);
    let parts = catalog::parts(ctx, m, &q)?;
    let gpu = crate::hardware::capacity_gpu(ctx);
    if gpu > 0 && parts.iter().map(|p| n(p, "size")).sum::<u64>() > gpu {
        cmd.arg("--offload-to-cpu");
    }
    for p in parts {
        if p["present"] != true {
            return Err(format!("缺少模型文件：{}", s(&p, "file")));
        }
        cmd.arg(format!("--{}", s(&p, "role"))).arg(s(&p, "path"));
    }
    cmd.args([
        "--steps",
        &m["steps"].to_string(),
        "--cfg-scale",
        &m["cfg"].to_string(),
        "--sampling-method",
        s(m, "sampler"),
        "-W",
        &m["width"].to_string(),
        "-H",
        &m["height"].to_string(),
    ]);
    if m["flow_shift"].as_f64().unwrap_or(0.) > 0. {
        cmd.args(["--flow-shift", &m["flow_shift"].to_string()]);
    }
    if m["kind"] == "video" {
        cmd.args([
            "--video-frames",
            &m["frames"].to_string(),
            "--fps",
            &m["fps"].to_string(),
        ]);
    }
    cmd.arg("--diffusion-fa").arg("--vae-tiling");
    cmd.args(arr(&m["args"]).iter().filter_map(Value::as_str));
    cmd.arg("--lora-model-dir").arg(loras(ctx)?);
    let file = fs::File::create(ctx.root.join("sd-server.log")).map_err(err)?;
    cmd.stdout(Stdio::from(file.try_clone().map_err(err)?))
        .stderr(Stdio::from(file));
    crate::engine::stop();
    stop();
    drop(listener);
    let mut run = RUN.lock().map_err(err)?;
    *run = Some(Running {
        child: cmd.spawn().map_err(err)?,
        id: s(a, "id").into(),
        quant: s(a, "quant").into(),
        port,
        ready: false,
    });
    drop(run);
    let client = local_client()?;
    let until = Instant::now() + Duration::from_secs(600);
    loop {
        if status()?["port"] != port {
            return Err(format!("画图引擎已退出\n{}", logs(ctx).join("\n")));
        }
        if client
            .get(format!("http://127.0.0.1:{port}/sdcpp/v1/capabilities"))
            .timeout(Duration::from_secs(2))
            .send()
            .is_ok_and(|r| r.status().is_success())
        {
            let mut run = RUN.lock().map_err(err)?;
            if let Some(st) = run.as_mut().filter(|st| st.port == port) {
                st.ready = true;
            }
            drop(run);
            return status();
        }
        if Instant::now() >= until {
            stop();
            return Err("等待画图引擎启动超时".into());
        }
        std::thread::sleep(Duration::from_millis(300));
    }
}
fn local_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(err)
}
fn response(r: reqwest::blocking::Response) -> Reply {
    let status = r.status();
    if !status.is_success() {
        return Err(format!(
            "引擎返回 {status}：{}",
            r.text().unwrap_or_default()
        ));
    }
    r.json().map_err(err)
}
fn generate(
    ctx: &Ctx,
    output: &Path,
    r: &Value,
    video: bool,
    progress: impl Fn([u64; 2]),
) -> Reply {
    let _guard = JOB.try_lock().map_err(|_| "已有生成任务正在运行")?;
    let epoch = CANCEL.load(Ordering::SeqCst);
    let st = status()?;
    if st["ready"] != true {
        return Err("请先加载画图模型".into());
    }
    let (m, _) = catalog::selection(ctx, s(&st, "model"), s(&st, "quant"))?;
    if (m["kind"] == "video") != video {
        return Err("模型类型与生成请求不匹配".into());
    }
    let seed = r["seed"].as_i64().filter(|v| *v >= 0).unwrap_or_else(|| {
        (SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
            % 2147483647) as i64
    });
    let steps = r.get("steps").unwrap_or(&m["steps"]);
    let kind = if video { "video" } else { "image" };
    let count = n(r, "count").max(1);
    let mut req = json!({"prompt":r["prompt"],"negative_prompt":s(r,"negative_prompt"),"width":r["width"],"height":r["height"],"seed":seed,
        "sample_params":{"sample_steps":steps,"sample_method":m["sampler"],"guidance":{"txt_cfg":r.get("cfg_scale").unwrap_or(&m["cfg"])}}});
    if m["flow_shift"].as_f64().unwrap_or(0.) > 0. {
        req["sample_params"]["flow_shift"] = m["flow_shift"].clone();
    }
    if video {
        req["video_frames"] = r["frames"].clone();
        req["fps"] = m["fps"].clone();
        req["output_format"] = json!("webm");
        for key in ["init_image", "end_image", "ref_images"] {
            if !r[key].is_null() {
                req[key] = r[key].clone();
            }
        }
    } else {
        req["batch_count"] = json!(count);
        req["output_format"] = json!("png");
        if !s(r, "ref_image").is_empty() {
            if m["edit"] == true {
                let mut references = vec![r["ref_image"].clone()];
                references.extend_from_slice(arr(&r["ref_images"]));
                req["ref_images"] = json!(references);
            } else {
                req["init_image"] = r["ref_image"].clone();
                req["strength"] = r["strength"].clone();
            }
        }
    }
    let locals = list_loras(ctx)?;
    let mut lora = vec![];
    for sel in arr(&r["loras"]) {
        let l = arr(&locals)
            .iter()
            .find(|v| v["name"] == sel["name"])
            .ok_or("没有找到选择的 LoRA")?;
        lora.push(json!({"path":l["file"],"multiplier":sel["weight"],"is_high_noise":false}));
    }
    req["lora"] = json!(lora);
    let client = local_client()?;
    let base = format!("http://127.0.0.1:{}", n(&st, "port"));
    let started = Instant::now();
    let job = response(
        client
            .post(format!(
                "{base}/sdcpp/v1/{}_gen",
                if video { "vid" } else { "img" }
            ))
            .json(&req)
            .send()
            .map_err(err)?,
    )?;
    let id = job["id"]
        .as_str()
        .filter(|x| {
            !x.is_empty()
                && x.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        })
        .ok_or("引擎未返回任务编号")?;
    let poll = format!("{base}/sdcpp/v1/jobs/{id}");
    let result = loop {
        if CANCEL.load(Ordering::SeqCst) != epoch {
            let _ = client.post(format!("{poll}/cancel")).send();
            return Err("生成已取消".into());
        }
        let state = response(client.get(&poll).send().map_err(err)?)?;
        match s(&state, "status") {
            "completed" | "succeeded" => break state["result"].clone(),
            "failed" | "cancelled" => {
                return Err(state["error"]["message"]
                    .as_str()
                    .unwrap_or("生成失败或已取消")
                    .into())
            }
            "queued" | "generating" | "running" => {}
            other => return Err(format!("引擎返回未知任务状态：{other}")),
        }
        let p = &state["progress"];
        if n(p, "total_steps") > 0 {
            progress([n(p, "step"), n(p, "total_steps")]);
        }
        std::thread::sleep(Duration::from_millis(350));
    };
    let entries = if video {
        std::slice::from_ref(&result)
    } else {
        arr(&result["images"])
    };
    if entries.is_empty() {
        return Err("引擎没有返回作品".into());
    }
    let mut saved = vec![];
    let prefix = format!("LocModel_{}_", ms());
    let outcome = (|| {
        for (i, item) in entries.iter().enumerate() {
            let data = decode(item["b64_json"].as_str().ok_or("作品数据缺失")?)?;
            let path = new_file(
                &output,
                &prefix,
                if video { ".webm" } else { ".png" },
                &data,
            )?;
            saved.push(json!({"path":path,"kind":kind,"model":m["name"],"model_id":m["id"],"quant":st["quant"],"prompt":r["prompt"],"negative_prompt":r["negative_prompt"],"steps":steps,"seed":seed.saturating_add(i as i64),"width":r["width"],"height":r["height"],"fps":result["fps"],"frames":result["frame_count"],"secs":started.elapsed().as_secs_f64(),"created_at":ms()as u64}));
        }
        if CANCEL.load(Ordering::SeqCst) != epoch {
            return Err("生成已取消".into());
        }
        update_history(ctx, &saved)
    })();
    if outcome.is_err() {
        for row in &saved {
            let _ = fs::remove_file(s(row, "path"));
        }
    }
    outcome
}
fn unpack(archive: &Path, dir: &Path) -> Result<PathBuf, String> {
    let mut zip = zip::ZipArchive::new(fs::File::open(archive).map_err(err)?).map_err(err)?;
    let mut bin = None;
    for i in 0..zip.len() {
        let entry = zip.by_index(i).map_err(err)?;
        let path = entry.enclosed_name().ok_or("压缩包包含无效路径")?;
        if entry.is_file() && path.file_name().and_then(|s| s.to_str()) == Some(BIN) {
            bin = Some(dir.join(path))
        }
    }
    let bin = bin.ok_or_else(|| format!("压缩包缺少 {BIN}"))?;
    zip.extract(dir).map_err(err)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).map_err(err)?;
    }
    Ok(bin)
}
fn release_asset<'a>(
    release: &'a Value,
    os: &str,
    arch: &str,
    cpu: bool,
) -> Result<(&'static str, &'a Value), String> {
    let (variant, platform) = match os {
        "macos" => ("metal", "-bin-darwin"),
        "windows" if cpu => ("cpu", "-bin-win-cpu-"),
        "windows" => ("vulkan", "-bin-win-vulkan-"),
        "linux" => ("cpu", "-bin-linux-"),
        _ => return Err("官方没有此系统的引擎包".into()),
    };
    let asset = arr(&release["assets"])
        .iter()
        .find(|a| {
            let name = s(a, "name").to_lowercase();
            name.starts_with("sd-")
                && name.contains(platform)
                && name.ends_with(".zip")
                && match arch {
                    "aarch64" => name.contains("arm64") || name.contains("aarch64"),
                    "x86_64" => name.contains("x64") || name.contains("x86_64"),
                    _ => false,
                }
                && (os != "linux"
                    || !name.contains("rocm") && !name.contains("vulkan") && !name.contains("cuda"))
        })
        .ok_or("官方目前没有适合本机的发布包，请手动导入")?;
    Ok((variant, asset))
}
fn install(ctx: &Ctx, app: &AppHandle, import: bool) -> Reply {
    let _lock = INSTALL.try_lock().map_err(|_| "引擎安装正在运行")?;
    let base = ensure(ctx.root.join("engines").join("diffusion"))?;
    let stage = tempfile::Builder::new()
        .prefix("sd-")
        .tempdir_in(&base)
        .map_err(err)?;
    let (archive, tag, variant) = if import {
        let Some(p) = rfd::FileDialog::new()
            .add_filter("引擎压缩包", &["zip"])
            .pick_file()
        else {
            return Ok(Value::Null);
        };
        let tag = p
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        (p, tag, "本地".to_owned())
    } else {
        let release = catalog::client()?
            .get("https://api.github.com/repos/leejet/stable-diffusion.cpp/releases/latest")
            .send()
            .and_then(|r| r.error_for_status())
            .map_err(err)?
            .json::<Value>()
            .map_err(err)?;
        let cfg = ctx.settings()?;
        let (variant, asset) = release_asset(
            &release,
            std::env::consts::OS,
            std::env::consts::ARCH,
            cfg["engine_cpu"] == true,
        )?;
        let tag = s(&release, "tag_name");
        let old = info(ctx)?;
        if old["tag"] == tag && old["variant"] == variant {
            return Ok(old);
        }
        let path = stage.path().join("release.zip");
        let official = s(asset, "browser_download_url");
        let mirror = s(&cfg, "github_mirror").trim_end_matches('/');
        let url = if mirror.is_empty() {
            official.to_owned()
        } else {
            format!("{mirror}/{official}")
        };
        let expected = s(asset, "digest")
            .strip_prefix("sha256:")
            .ok_or("发布包没有 SHA-256 校验值")?;
        catalog::transfer(app, "sdengine", |flag| {
            catalog::download(app, "sdengine", catalog::client()?.get(url), &path, flag)?;
            use sha2::{Digest, Sha256};
            let mut digest = Sha256::new();
            io::copy(&mut fs::File::open(&path).map_err(err)?, &mut digest).map_err(err)?;
            if format!("{:x}", digest.finalize()) != expected {
                return Err("引擎包 SHA-256 校验失败".into());
            }
            Ok(())
        })?;
        (path, tag.to_owned(), variant.to_owned())
    };
    let bin = unpack(&archive, stage.path())?;
    if !import {
        fs::remove_file(archive).map_err(err)?
    }
    let dir = stage.keep();
    let v = json!({"tag":tag,"variant":variant,"server_path":bin});
    if let Err(e) = ctx.write("image_engine", &v) {
        let _ = fs::remove_dir_all(dir);
        return Err(e);
    }
    Ok(v)
}
pub(super) fn handle(cmd: &str, a: &Value, ctx: &Ctx, app: &AppHandle) -> Option<Reply> {
    Some(match cmd {
        "image_engine_status" => info(ctx),
        "install_image_engine" | "import_image_engine_zip" => {
            install(ctx, app, cmd.starts_with("import"))
        }
        "image_status" => status(),
        "start_image" => start(ctx, a),
        "stop_image" => {
            stop();
            status()
        }
        "cancel_video" => {
            CANCEL.fetch_add(1, Ordering::SeqCst);
            Ok(Value::Null)
        }
        "image_logs" => Ok(json!(logs(ctx))),
        "generate_video" | "generate_image" => images(ctx, app).and_then(|output| {
            generate(ctx, &output, &a["req"], cmd == "generate_video", |p| {
                let _ = app.emit("image-progress", p);
            })
        }),
        _ => return None,
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn release_packages_match_system_architecture_and_backend() {
        let names = [
            "cudart-sd-bin-win-cu12-x64.zip",
            "sd-master-abc-bin-Darwin-macOS-26.7.2-arm64.zip",
            "sd-master-abc-bin-win-cpu-x64.zip",
            "sd-master-abc-bin-win-cuda12-x64.zip",
            "sd-master-abc-bin-win-vulkan-x64.zip",
            "sd-master-abc-bin-Linux-Ubuntu-26.04-x86_64-vulkan.zip",
            "sd-master-abc-bin-Linux-Ubuntu-26.04-x86_64.zip",
        ];
        let release = json!({"assets":names.iter().map(|n|json!({"name":n})).collect::<Vec<_>>()});
        for (os, arch, cpu, index) in [
            ("macos", "aarch64", false, 1),
            ("windows", "x86_64", true, 2),
            ("windows", "x86_64", false, 4),
            ("linux", "x86_64", false, 6),
        ] {
            assert_eq!(
                release_asset(&release, os, arch, cpu).unwrap().1["name"],
                names[index]
            );
        }
        assert!(release_asset(&release, "macos", "x86_64", false).is_err());
    }
    #[test]
    fn image_and_video_job_contract_history_and_delete() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = Ctx::new(tmp.path().to_path_buf()).unwrap();
        let bin = tmp.path().join("sd-server");
        fs::write(&bin,r#"#!/usr/bin/env python3
from http.server import BaseHTTPRequestHandler, HTTPServer
import json,sys
class Handler(BaseHTTPRequestHandler):
    def reply(self, data):
        body=json.dumps(data).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def do_GET(self):
        if self.path=="/sdcpp/v1/capabilities":
            self.reply({"supported_modes":["img_gen","vid_gen"]})
            return
        assert self.path=="/sdcpp/v1/jobs/test1"
        if self.server.hold:
            self.reply({"status":"generating","progress":{"step":1,"total_steps":3}})
            return
        data={"b64_json":"dmlkZW8=","fps":16,"frame_count":33} if self.server.video else {"images":[{"b64_json":"aW1hZ2U="}]}
        self.reply({"status":"completed","result":data})
    def do_POST(self):
        if self.path=="/sdcpp/v1/jobs/test1/cancel":
            open("cancel-received","w").close()
            self.reply({"cancel_requested":True})
            return
        video=self.path=="/sdcpp/v1/vid_gen"
        assert video or self.path=="/sdcpp/v1/img_gen"
        self.server.video=video
        req=json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.server.hold=req["prompt"]=="cancel"
        assert req["sample_params"]["sample_steps"]==3 and req["seed"]==42
        assert req["lora"]==[{"path":"red.safetensors","multiplier":0.5,"is_high_noise":False}]
        if video:
            assert req["fps"]==16 and req["video_frames"]==33 and req["output_format"]=="webm"
        else:
            assert req["output_format"]=="png" and req["batch_count"]==1
            assert req["ref_images"]==["first","second","third","fourth"]
        self.reply({"id":"test1"})
port=int(sys.argv[sys.argv.index("--listen-port")+1])
HTTPServer(("127.0.0.1",port),Handler).serve_forever()
"#).unwrap();
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
        ctx.write("image_engine", &json!({"server_path":bin}))
            .unwrap();
        fs::write(loras(&ctx).unwrap().join("red.safetensors"), b"fixture").unwrap();
        struct Cleanup;
        impl Drop for Cleanup {
            fn drop(&mut self) {
                stop();
            }
        }
        let _cleanup = Cleanup;
        let mut rows = vec![];
        for (id, quant, video) in [
            ("qwen-image-edit", "Q4_K_M", false),
            ("wan2.1-t2v-1.3b", "FP16", true),
        ] {
            let (m, q) = catalog::selection(&ctx, id, quant).unwrap();
            for p in catalog::parts(&ctx, m, &q).unwrap() {
                let p = Path::new(s(&p, "path"));
                fs::create_dir_all(p.parent().unwrap()).unwrap();
                fs::write(p, b"fixture").unwrap();
            }
            assert_eq!(
                start(&ctx, &json!({"id":id,"quant":quant})).unwrap()["ready"],
                true
            );
            let mut req = json!({"prompt":"fixture","width":128,"height":128,"steps":3,"seed":42,"frames":33,"loras":[{"name":"red","weight":0.5}]});
            if !video {
                req["ref_image"] = json!("first");
                req["ref_images"] = json!(["second", "third", "fourth"]);
            }
            let output = generate(&ctx, tmp.path(), &req, video, |_| {}).unwrap();
            let record = output[0].clone();
            let path = s(&record, "path");
            assert_eq!(
                fs::read(path).unwrap(),
                if video { b"video" } else { b"image" }
            );
            assert_eq!(record["seed"], 42);
            if video {
                assert_eq!(record["frames"], 33);
                req["prompt"] = json!("cancel");
                assert!(generate(&ctx, tmp.path(), &req, true, |_| {
                    CANCEL.fetch_add(1, Ordering::SeqCst);
                })
                .unwrap_err()
                .contains("取消"));
                assert!(tmp.path().join("cancel-received").is_file());
            }
            rows.push(record);
        }
        let history = ctx.read("images", json!([])).unwrap();
        assert_eq!(history, json!([rows[1], rows[0]]));
        let path = Path::new(s(&rows[0], "path"));
        delete(&ctx, path).unwrap();
        assert!(!path.exists());
        assert!(delete(&ctx, &bin).is_err());
        assert!(bin.exists());
    }
}
