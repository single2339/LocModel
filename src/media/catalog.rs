use super::*;
use std::{
    collections::HashMap,
    io::Read,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Instant,
};
use tauri::Emitter;

static MODELS: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("catalog.json")).expect("embedded image catalog")
});
static DOWNLOADS: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    LazyLock::new(Default::default);
pub fn cancel_download(id: &str) {
    if let Some(flag) = DOWNLOADS.lock().unwrap().get(id) {
        flag.store(true, Ordering::Release)
    }
}
pub(super) fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .user_agent("LocModel/3.1.0")
        .connect_timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(err)
}
pub(super) fn transfer<T>(
    app: &AppHandle,
    id: &str,
    op: impl FnOnce(&AtomicBool) -> Result<T, String>,
) -> Result<T, String> {
    let flag = Arc::new(AtomicBool::new(false));
    {
        let mut map = DOWNLOADS.lock().map_err(err)?;
        if map.contains_key(id) {
            return Err("下载任务已经启动".into());
        }
        map.insert(id.into(), flag.clone());
    }
    let result = op(&flag);
    let state = match &result {
        Ok(_) => "done",
        Err(_) if flag.load(Ordering::Acquire) => "cancelled",
        _ => "error",
    };
    let _ = app.emit(
        "download-progress",
        json!({"id":id,"status":state,"message":result.as_ref().err()}),
    );
    DOWNLOADS.lock().map_err(err)?.remove(id);
    result
}
pub(super) fn download(
    app: &AppHandle,
    id: &str,
    request: reqwest::blocking::RequestBuilder,
    path: &Path,
    flag: &AtomicBool,
) -> Result<(), String> {
    download_with(app, id, path, flag, |range| {
        let mut r = request.try_clone().ok_or("无法重试下载")?;
        if let Some((offset, tag)) = range {
            r = r.header("Range", format!("bytes={offset}-"));
            if let Some(tag) = tag {
                r = r.header("If-Range", tag);
            }
        }
        Ok((r.send().map_err(err)?, ""))
    })
}

fn download_with(
    app: &AppHandle,
    id: &str,
    path: &Path,
    flag: &AtomicBool,
    fetch: impl Fn(
        Option<(u64, Option<&str>)>,
    ) -> Result<(reqwest::blocking::Response, &'static str), String>,
) -> Result<(), String> {
    use std::io::{Seek, SeekFrom};
    let name = path
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or("下载文件名无效")?;
    let part = path.with_file_name(format!("{name}.part"));
    let validator = path.with_file_name(format!("{name}.part.etag"));
    let mut file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&part)
        .map_err(err)?;
    file.try_lock().map_err(|_| "另一个任务正在下载该文件")?;
    let offset = file.metadata().map_err(err)?.len();
    let saved = fs::read_to_string(&validator)
        .ok()
        .filter(|s| !s.is_empty());
    let resume = offset > 0 && saved.is_some();
    let (mut response, mut route) = fetch(resume.then_some((offset, saved.as_deref())))?;
    if resume && response.status() == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
        (response, route) = fetch(None)?;
    }
    response = response.error_for_status().map_err(err)?;
    let partial = response.status() == reqwest::StatusCode::PARTIAL_CONTENT;
    if partial
        && (!resume
            || !response
                .headers()
                .get("content-range")
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| v.starts_with(&format!("bytes {offset}-"))))
    {
        return Err("续传范围不匹配".into());
    }
    let start_offset = if partial {
        offset
    } else {
        file.set_len(0).map_err(err)?;
        0
    };
    file.seek(SeekFrom::Start(start_offset)).map_err(err)?;
    let tag = response
        .headers()
        .get("etag")
        .filter(|v| !v.as_bytes().starts_with(b"W/"))
        .or_else(|| response.headers().get("last-modified"));
    fs::write(&validator, tag.map(|v| v.as_bytes()).unwrap_or_default()).map_err(err)?;
    let total = if partial {
        response
            .headers()
            .get("content-range")
            .and_then(|s| s.to_str().ok())
            .and_then(|s| s.rsplit_once('/'))
            .and_then(|(_, total)| total.parse::<u64>().ok())
            .ok_or("续传响应缺少文件总长度")?
    } else {
        response.content_length().unwrap_or(0)
    };
    let mut buffer = [0; 65536];
    let mut done = start_offset;
    let start = Instant::now();
    let mut last = None;
    loop {
        if flag.load(Ordering::Acquire) {
            return Err("下载已取消".into());
        }
        let count = response.read(&mut buffer).map_err(err)?;
        if count == 0 {
            break;
        }
        file.write_all(&buffer[..count]).map_err(err)?;
        done += count as u64;
        if last.is_none_or(|t: Instant| t.elapsed().as_millis() >= 300) {
            let _=app.emit("download-progress",json!({"id":id,"status":"downloading","route":route,"done":done,"total":total,"speed":(done-start_offset) as f64/start.elapsed().as_secs_f64().max(0.001)}));
            last = Some(Instant::now());
        }
    }
    if done == 0 || total > 0 && done != total {
        return Err("下载文件不完整".into());
    }
    file.flush().map_err(err)?;
    fs::rename(&part, path).map_err(err)?;
    let _ = fs::remove_file(validator);
    Ok(())
}
fn models_root(ctx: &Ctx) -> Result<PathBuf, String> {
    let cfg = ctx.settings()?;
    Ok(if s(&cfg, "models_dir").is_empty() {
        ctx.root.join("models")
    } else {
        PathBuf::from(s(&cfg, "models_dir"))
    })
}
fn family_dir(ctx: &Ctx, m: &Value) -> Result<PathBuf, String> {
    Ok(models_root(ctx)?.join("image").join(s(m, "id")))
}
fn base_name(name: &str) -> &str {
    name.rsplit('/').next().unwrap_or(name)
}
pub(super) fn parts(ctx: &Ctx, m: &Value, q: &Value) -> Result<Vec<Value>, String> {
    let dir = family_dir(ctx, m)?;
    let mut out = vec![];
    let mut push = |role: &str, repo: &str, file: &str, size: u64| {
        if file.is_empty() {
            return;
        }
        let name = base_name(file);
        let path = dir.join(name);
        let present = path.metadata().is_ok_and(|v| v.is_file() && v.len() > 0);
        out.push(json!({"role":role,"label":role,"repo":repo,"remote":file,"file":name,"path":path,"size":size,"present":present}));
    };
    push("diffusion-model", s(m, "repo"), s(q, "file"), n(q, "size"));
    push(
        "high-noise-diffusion-model",
        s(m, "repo"),
        s(q, "high_file"),
        n(q, "high_size"),
    );
    for p in arr(&m["parts"]) {
        push(s(p, "role"), s(p, "repo"), s(p, "file"), n(p, "size"))
    }
    Ok(out)
}
fn model(id: &str) -> Result<&'static Value, String> {
    arr(&MODELS)
        .iter()
        .find(|m| m["id"] == id)
        .ok_or("未知画图模型".into())
}
fn quants(ctx: &Ctx, m: &Value) -> Result<Vec<Value>, String> {
    let mut qs = arr(&m["quants"]).to_vec();
    let dir = family_dir(ctx, m)?;
    if dir.is_dir() {
        for entry in fs::read_dir(dir).map_err(err)? {
            let p = entry.map_err(err)?.path();
            if !p.is_file() || !matches!(ext(&p).as_str(), "gguf" | "safetensors") {
                continue;
            }
            let name = p.file_name().unwrap().to_string_lossy();
            if qs.iter().any(|q| {
                ["file", "high_file"]
                    .iter()
                    .any(|k| base_name(s(q, k)) == name)
            }) || arr(&m["parts"])
                .iter()
                .any(|v| base_name(s(v, "file")) == name)
            {
                continue;
            }
            qs.push(json!({"quant":format!("local:{name}"),"file":name,"size":p.metadata().map_err(err)?.len()}));
        }
    }
    Ok(qs)
}
pub(super) fn selection(
    ctx: &Ctx,
    id: &str,
    quant: &str,
) -> Result<(&'static Value, Value), String> {
    let m = model(id)?;
    let q = quants(ctx, m)?
        .into_iter()
        .find(|v| v["quant"] == quant)
        .ok_or("未知量化版本")?;
    Ok((m, q))
}
fn catalog(ctx: &Ctx) -> Reply {
    let mut rows = vec![];
    let gpu = crate::hardware::capacity_gpu(ctx);
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    let ram = sys.available_memory();
    let capacity = if crate::hardware::gpu_memory_is_shared(ctx) {
        ram
    } else {
        ram.saturating_add(gpu)
    };
    for src in arr(&MODELS) {
        let mut m = src.clone();
        let mut qs = quants(ctx, src)?;
        for q in &mut qs {
            let parts = parts(ctx, src, q)?;
            let total: u64 = parts.iter().map(|p| n(p, "size")).sum();
            let missing: Vec<_> = parts.iter().filter(|p| p["present"] != true).collect();
            q["bytes"] = json!(total);
            q["need_bytes"] = json!(missing.iter().map(|p| n(p, "size")).sum::<u64>());
            q["has_main"] = parts[0]["present"].clone();
            q["installed"] = json!(missing.is_empty());
            q["missing"] = json!(missing);
            let (tier, label) = if gpu >= total {
                ("fast", "显存充足")
            } else if total > capacity {
                ("no", "内存不足")
            } else if gpu >= n(q, "size") {
                ("ok", "可运行")
            } else {
                ("slow", "部分放内存")
            };
            q["tier"] = json!(tier);
            q["tier_label"] = json!(label);
        }
        let rec = qs
            .iter()
            .rev()
            .find(|q| q["tier"] == "fast")
            .or_else(|| qs.iter().find(|q| s(q, "quant").starts_with("Q4")))
            .unwrap_or(&qs[0]);
        m["rec_quant"] = rec["quant"].clone();
        m["quants"] = json!(qs);
        rows.push(m)
    }
    Ok(json!(rows))
}
fn download_model(ctx: &Ctx, app: &AppHandle, a: &Value) -> Reply {
    let (m, q) = selection(ctx, s(a, "id"), s(a, "quant"))?;
    let id = format!("img:{}:{}", s(m, "id"), s(&q, "quant"));
    ensure(family_dir(ctx, m)?)?;
    transfer(app, &id, |flag| {
        let routes = crate::models::routes::Routes::new(ctx)?;
        for p in parts(ctx, m, &q)? {
            if p["present"] == true {
                continue;
            }
            let parts = [s(&p, "repo"), "resolve", "main", s(&p, "remote")];
            download_with(app, &id, Path::new(s(&p, "path")), flag, |range| {
                routes.fetch(false, &parts, &[], range)
            })?;
        }
        Ok(Value::Null)
    })
}
fn regular_model(p: &Path) -> bool {
    p.is_file() && matches!(ext(p).as_str(), "safetensors" | "gguf")
}
fn identify(name: &str) -> Option<&'static Value> {
    let key = name.to_lowercase().replace(['-', '.'], "_");
    let models = arr(&MODELS);
    models
        .iter()
        .find(|m| {
            arr(&m["quants"]).iter().any(|q| {
                ["file", "high_file"]
                    .iter()
                    .any(|k| base_name(s(q, k)).eq_ignore_ascii_case(name))
            })
        })
        .or_else(|| {
            models
                .iter()
                .filter(|m| {
                    let id = s(m, "id").replace(['-', '.'], "_");
                    key.contains(&id)
                        || match s(m, "id") {
                            "qwen-image-2.1" => key.contains("qwen_image2_1"),
                            "flux2-klein-4b" => key.contains("flux_2_klein_4b"),
                            "minimax-h3-ref" => key.contains("minimax_h3_ref2va"),
                            _ => false,
                        }
                })
                .max_by_key(|m| s(m, "id").len())
        })
}
fn import(ctx: &Ctx, a: &Value, move_file: bool) -> Reply {
    let path = if s(a, "path").is_empty() {
        let Some(path) = rfd::FileDialog::new()
            .add_filter("模型", &["gguf", "safetensors"])
            .pick_file()
        else {
            return Ok(Value::Null);
        };
        path
    } else {
        PathBuf::from(s(a, "path"))
    };
    if !regular_model(&path) {
        return Err("请选择 GGUF 或 safetensors 模型".into());
    }
    let name = path
        .file_name()
        .and_then(|v| v.to_str())
        .ok_or("文件名无效")?;
    let m = if !s(a, "id").is_empty() {
        model(s(a, "id"))?
    } else {
        identify(name).ok_or_else(|| format!("UNKNOWN_FAMILY|{name}|{}", path.display()))?
    };
    let quant = arr(&m["quants"]).iter().find(|q| {
        base_name(s(q, "file")).eq_ignore_ascii_case(name)
            || base_name(s(q, "high_file")).eq_ignore_ascii_case(name)
    });
    let dest_name = quant
        .map(|q| {
            if base_name(s(q, "high_file")).eq_ignore_ascii_case(name) {
                base_name(s(q, "high_file"))
            } else {
                base_name(s(q, "file"))
            }
        })
        .unwrap_or(name);
    let to = ensure(family_dir(ctx, m)?)?.join(dest_name);
    copy_new(&path, &to)?;
    let canonical = path.canonicalize().map_err(err)?;
    if move_file && canonical != to.canonicalize().map_err(err)? {
        fs::remove_file(&path).map_err(err)?;
        crate::models::forget_moved(ctx, &canonical)?;
    }
    Ok(
        json!({"id":m["id"],"kind":m["kind"],"name":m["name"],"quant":quant.map(|v|s(v,"quant").to_string()).unwrap_or_else(||format!("local:{name}"))}),
    )
}
fn adopt_all(ctx: &Ctx) -> Reply {
    let root = models_root(ctx)?;
    let mut moved = vec![];
    let mut dirs = vec![root.clone()];
    while let Some(dir) = dirs.pop() {
        if !dir.is_dir() {
            continue;
        }
        for entry in fs::read_dir(&dir).map_err(err)? {
            let entry = entry.map_err(err)?;
            let p = entry.path();
            let ty = entry.file_type().map_err(err)?;
            if ty.is_dir() && p != root.join("image") {
                dirs.push(p);
                continue;
            }
            if ty.is_file()
                && regular_model(&p)
                && identify(&entry.file_name().to_string_lossy()).is_some()
            {
                moved.push(import(ctx, &json!({"path":p}), true)?)
            }
        }
    }
    Ok(json!(moved))
}
pub(super) fn handle(cmd: &str, a: &Value, ctx: &Ctx, app: &AppHandle) -> Option<Reply> {
    Some(match cmd {
        "image_catalog" => catalog(ctx),
        "download_image_model" => download_model(ctx, app, a),
        "import_image_file" | "adopt_image_model" => import(ctx, a, cmd == "adopt_image_model"),
        "auto_adopt_image_models" => adopt_all(ctx),
        "import_image_parts" => (|| {
            let m = model(s(a, "id"))?;
            let dir = ensure(family_dir(ctx, m)?)?;
            let mut names = vec![];
            let files = rfd::FileDialog::new()
                .add_filter("组件", &["gguf", "safetensors"])
                .pick_files()
                .unwrap_or_default();
            for p in files {
                let name = p.file_name().and_then(|v| v.to_str()).ok_or("文件名无效")?;
                let part = arr(&m["parts"])
                    .iter()
                    .find(|v| base_name(s(v, "file")).eq_ignore_ascii_case(name))
                    .ok_or_else(|| format!("该模型无需组件 {name}"))?;
                copy_new(&p, &dir.join(base_name(s(part, "file"))))?;
                names.push(name.to_owned());
            }
            Ok(json!(names))
        })(),
        "delete_image_model" => (|| {
            let (m, q) = selection(ctx, s(a, "id"), s(a, "quant"))?;
            for p in parts(ctx, m, &q)? {
                if s(&p, "role").ends_with("diffusion-model") && p["present"] == true {
                    fs::remove_file(s(&p, "path")).map_err(err)?
                }
            }
            Ok(Value::Null)
        })(),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn original_catalog_and_partial_import() {
        let models = arr(&MODELS);
        assert_eq!(models.len(), 12);
        for m in models {
            for q in arr(&m["quants"]) {
                assert_eq!(identify(base_name(s(q, "file"))).unwrap()["id"], m["id"]);
                assert!(n(q, "size") > 0);
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let ctx = Ctx::new(dir.path().into()).unwrap();
        let qname = "z_image_turbo-Q4_K.gguf";
        let file = dir.path().join(qname);
        fs::write(&file, b"fixture").unwrap();
        let imported = import(&ctx, &json!({"path":file}), false).unwrap();
        assert_eq!(imported["quant"], "Q4_K");
        let (m, q) = selection(&ctx, "z-image-turbo", "Q4_K").unwrap();
        let components = parts(&ctx, m, &q).unwrap();
        assert_eq!(components.len(), 3);
        assert_eq!(components[0]["present"], true);
        assert_eq!(components[1]["present"], false);
        assert!(file.exists());
        assert_eq!(s(&components[1], "role"), "llm");
    }
}
