mod gguf;
mod hub;
pub(crate) mod routes;
use crate::{Ctx, Reply};
pub(crate) use routes::ping_servers;
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

const GIB: u64 = 1 << 30;
fn argument<'a>(a: &'a Value, key: &str) -> Result<&'a str, String> {
    a[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("缺少参数 {key}"))
}
fn index(ctx: &Ctx) -> Reply {
    ctx.read("model_index", json!({}))
}
fn update(ctx: &Ctx, op: impl FnOnce(&mut Value) -> Result<(), String>) -> Result<(), String> {
    ctx.update("model_index", json!({}), op).map(|_| ())
}
fn base(ctx: &Ctx) -> Result<PathBuf, String> {
    Ok(ctx.settings()?["models_dir"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| ctx.root.join("models")))
}
struct Capacity {
    ram: u64,
    gpu: u64,
}
impl Capacity {
    fn read(ctx: &Ctx) -> Result<Self, String> {
        let s = ctx.settings()?;
        let mut sys = sysinfo::System::new();
        sys.refresh_memory();
        let gpu = if s["engine_cpu"] == true {
            0
        } else {
            crate::hardware::capacity_gpu(ctx)
        };
        let mut ram = crate::hardware::available_ram(&sys).saturating_sub(GIB);
        if crate::hardware::gpu_memory_is_shared(ctx) {
            ram = ram.saturating_sub(gpu)
        }
        Ok(Self { ram, gpu })
    }
    fn plan(&self, size: u64, ctx: u64) -> Value {
        let kv = ctx.saturating_mul(128 * 1024);
        let gpu = size.min(self.gpu.saturating_sub(kv.saturating_add(GIB / 2)));
        let ram = (size - gpu).min(self.ram.saturating_sub(if gpu == 0 { kv } else { 0 }));
        let disk = size - gpu - ram;
        let (tier, label) = if disk > 0 {
            ("slow", "需要磁盘换页")
        } else if gpu == size {
            ("fast", "显存可容纳")
        } else {
            ("ok", "内存可容纳")
        };
        let seconds = (gpu as f64 / 180. + ram as f64 / 24. + disk as f64 / 0.3) / GIB as f64;
        json!({"tier":tier,"tier_label":label,"summary":format!("按可用内存估算。{label}。"),"ctx":ctx,"kv_bytes":kv,
               "gpu_bytes":gpu,"ram_bytes":ram,"disk_bytes":disk,"gpu_note":"按可用显存容量估算","ram_note":"预留系统和缓存空间","disk_note":"超出容量时按需读取","est_tps":1./seconds.max(0.01)})
    }
}
fn get_model(row: &Value, p: &Path, cap: &Capacity, n: u64) -> Reply {
    let mut m = gguf::describe(
        p,
        row["imported"].as_bool().unwrap_or(true),
        &row["repo"],
        &row["mmproj"],
    )?;
    let max = m["info"]["ctx_max"].as_u64().unwrap_or(0);
    let context = if n == 0 { 8192 } else { n };
    let context = if max > 0 { context.min(max) } else { context };
    m["plan"] = cap.plan(m["info"]["total_bytes"].as_u64().unwrap_or(0), context);
    Ok(m)
}
pub fn lookup(ctx: &Ctx, path: &str) -> Reply {
    get_model(
        &index(ctx)?[path],
        Path::new(path),
        &Capacity::read(ctx)?,
        0,
    )
}
fn register(ctx: &Ctx, p: &Path, imported: bool, repo: Value, projector: Option<&Path>) -> Reply {
    let path = fs::canonicalize(p).map_err(|e| e.to_string())?;
    if gguf::is_projector(&path) {
        return Err("请选择主模型 GGUF 文件".into());
    }
    let path = gguf::shards(&path).map_err(|e| e.to_string())?.remove(0);
    let key = path.to_str().ok_or("模型路径不是 UTF-8")?;
    let mut row = json!({"imported":imported,"repo":repo});
    let cap = Capacity::read(ctx)?;
    let mut result = Value::Null;
    update(ctx, |rows| {
        if !rows[key].is_null() {
            row = rows[key].clone()
        }
        if let Some(file) = projector {
            row["mmproj"] = json!(file);
            row["owned_projector"] = json!(file);
        }
        result = get_model(&row, &path, &cap, 0)?;
        rows[key] = row;
        Ok(())
    })?;
    Ok(result)
}
fn list(ctx: &Ctx) -> Reply {
    let rows = index(ctx)?;
    let cap = Capacity::read(ctx)?;
    let mut out = Vec::new();
    if let Some(obj) = rows.as_object() {
        for (p, r) in obj {
            if Path::new(p).is_file() {
                out.push(get_model(r, Path::new(p), &cap, 0)?);
            }
        }
    }
    Ok(json!(out))
}
pub fn forget_moved(ctx: &Ctx, old_path: &Path) -> Result<(), String> {
    let Some(key) = old_path.to_str() else {
        return Ok(());
    };
    let rows = index(ctx)?;
    if rows.get(key).is_some() {
        update(ctx, |rows| {
            rows.as_object_mut().ok_or("模型索引损坏")?.remove(key);
            Ok(())
        })?
    }
    Ok(())
}
fn restore_vision(ctx: &Ctx, a: &Value) -> Reply {
    let key = argument(a, "path")?;
    if index(ctx)?[key].is_null() {
        return Err("模型未登记".into());
    }
    ctx.update("safe_levels", json!({}), |levels| {
        if levels[key].as_u64().unwrap_or(0) >= 4 {
            levels[key] = json!(3)
        }
        Ok(())
    })?;
    Ok(Value::Null)
}
fn remove(ctx: &Ctx, a: &Value) -> Reply {
    let key = argument(a, "path")?;
    update(ctx, |rows| {
        let row = &rows[key];
        if row.is_null() {
            return Err("模型未登记".into());
        }
        if a["deleteFiles"] == true && row["imported"] == false {
            let mut files = gguf::shards(Path::new(key)).map_err(|e| e.to_string())?;
            if let Some(projector) = row["owned_projector"].as_str() {
                files.push(PathBuf::from(projector));
            }
            for p in files {
                match fs::remove_file(&p) {
                    Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.to_string()),
                    _ => (),
                }
            }
        }
        rows.as_object_mut().ok_or("模型索引损坏")?.remove(key);
        Ok(())
    })?;
    Ok(Value::Null)
}
pub fn catalog(ctx: &Ctx) -> Reply {
    let src: Value =
        serde_json::from_str(include_str!("../assets/catalog.json")).map_err(|e| e.to_string())?;
    let rows = index(ctx)?;
    let cap = Capacity::read(ctx)?;
    let mut out = Vec::new();
    for m in src["models"].as_array().ok_or("模型目录损坏")? {
        let mut best = None;
        for q in m["quants"].as_array().ok_or("量化列表损坏")? {
            let q = q.as_str().ok_or("量化名称无效")?;
            let bits = if q == "F16" {
                16.
            } else {
                q.chars().find_map(|c| c.to_digit(10)).unwrap_or(4) as f64 + 0.65
            };
            let gb = m["size_gb"][q]
                .as_f64()
                .unwrap_or(m["params_b"].as_f64().unwrap_or(1.) * bits / 8.);
            let size = (gb * GIB as f64) as u64;
            let p = cap.plan(size, 8192);
            let quality = if bits <= 6. {
                bits
            } else {
                6. - (bits - 6.) * 0.1
            };
            let score = if size <= cap.gpu.saturating_sub(GIB) {
                300. + quality
            } else if size <= cap.ram + cap.gpu.saturating_sub(GIB) {
                200. + quality
            } else {
                100. - gb
            };
            if best.as_ref().is_none_or(|(s, _)| score > *s) {
                best = Some((score, json!({"model":m,"quant":q,"bytes":size,"plan":p})))
            }
        }
        if let Some((score, rec)) = best {
            let installed = rows
                .as_object()
                .and_then(|o| {
                    o.iter()
                        .find(|(p, r)| r["repo"] == m["repo"] && Path::new(p).is_file())
                })
                .map(|(p, _)| p);
            out.push((score, json!({"rec":rec,"installed_path":installed})))
        }
    }
    out.sort_by(|a, b| b.0.total_cmp(&a.0));
    Ok(json!(out.into_iter().map(|(_, v)| v).collect::<Vec<_>>()))
}
fn preview(ctx: &Ctx, a: &Value) -> Reply {
    let path = argument(a, "path")?;
    let m = get_model(
        &index(ctx)?[path],
        Path::new(path),
        &Capacity::read(ctx)?,
        a["ctx"].as_u64().unwrap_or(0),
    )?;
    let s = ctx.settings()?;
    let custom = ctx.read("custom_args", json!({}))?;
    let args = custom[path].as_str().unwrap_or("");
    let level = ctx.read("safe_levels", json!({}))?[path]
        .as_u64()
        .unwrap_or(0);
    let port = s["port"].as_u64().unwrap_or(8686) as u16;
    let mut launch = crate::engine::launch_args(
        &s,
        path,
        m["plan"]["ctx"].as_u64().unwrap_or(8192),
        port,
        level,
        m["mmproj"].as_str(),
        args,
    )?;
    let mut editable = Vec::new();
    let mut tokens = launch.iter();
    while let Some(token) = tokens.next() {
        if matches!(
            token.as_str(),
            "-m" | "--model" | "--mmproj" | "--host" | "--port"
        ) {
            tokens.next();
        } else {
            editable.push(token.as_str());
        }
    }
    let editable_args = shell_words::join(editable);
    launch.insert(0, "llama-server".into());
    let cmd = shell_words::join(launch);
    Ok(
        json!({"model":m,"plan":m["plan"],"command":cmd,"custom_args":args,"editable_args":editable_args}),
    )
}
fn pick_projector(ctx: &Ctx, a: &Value) -> Reply {
    let key = argument(a, "path")?;
    let Some(p) = rfd::FileDialog::new()
        .add_filter("GGUF", &["gguf"])
        .pick_file()
    else {
        return Ok(Value::Null);
    };
    gguf::metadata(&p).map_err(|e| e.to_string())?;
    update(ctx, |rows| {
        if rows[key].is_null() {
            return Err("模型未登记".into());
        }
        rows[key]["mmproj"] = json!(p);
        Ok(())
    })?;
    Ok(json!(p))
}
pub fn handle(cmd: &str, a: &Value, ctx: &Ctx, app: &tauri::AppHandle) -> Option<Reply> {
    Some(match cmd {
        "get_catalog" => catalog(ctx),
        "list_local" => list(ctx),
        "remove_local" => remove(ctx, a),
        "pick_gguf" => Ok(json!(rfd::FileDialog::new()
            .add_filter("GGUF", &["gguf"])
            .pick_file())),
        "import_path" => {
            argument(a, "path").and_then(|p| register(ctx, Path::new(p), true, Value::Null, None))
        }
        "plan_model" => preview(ctx, a),
        "pick_mmproj_file" => pick_projector(ctx, a),
        "restore_vision" => restore_vision(ctx, a),
        "repo_quants" | "search_hf" | "download_model" | "cancel_download" | "fetch_mmproj" => {
            hub::handle(cmd, a, ctx, app)
        }
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn importing_and_removing_a_split_model_preserves_source_files() {
        let tmp = tempfile::tempdir().unwrap();
        let ctx = Ctx::new(tmp.path().join("state")).unwrap();
        let mut fixture = b"GGUF".to_vec();
        fixture.extend(3u32.to_le_bytes());
        fixture.extend(0u64.to_le_bytes());
        fixture.extend(0u64.to_le_bytes());
        let first = tmp.path().join("model-Q4_K_M-00001-of-00002.gguf");
        let second = tmp.path().join("model-Q4_K_M-00002-of-00002.gguf");
        fs::write(&first, &fixture).unwrap();
        assert!(register(&ctx, &first, true, Value::Null, None).is_err());
        fs::write(&second, &fixture).unwrap();
        let model = register(&ctx, &second, true, Value::Null, None).unwrap();
        assert_eq!(model["info"]["total_bytes"], 48);
        assert_eq!(model["info"]["file_type"], "Q4_K_M");
        assert_eq!(list(&ctx).unwrap().as_array().unwrap().len(), 1);
        let args = json!({"path":model["path"],"ctx":2048,"deleteFiles":true});
        ctx.write(
            "custom_args",
            &json!({(model["path"].as_str().unwrap()):"--alias 'Model With Spaces'"}),
        )
        .unwrap();
        let preview = preview(&ctx, &args).unwrap();
        assert_eq!(preview["plan"]["ctx"], 2048);
        let editable = shell_words::split(preview["editable_args"].as_str().unwrap()).unwrap();
        assert!(editable.iter().any(|s| s == "Model With Spaces"));
        assert!(!editable.iter().any(|s| s == "-m" || s == "--port"));
        ctx.write("safe_levels", &json!({(model["path"].as_str().unwrap()):5}))
            .unwrap();
        restore_vision(&ctx, &args).unwrap();
        assert_eq!(
            ctx.read("safe_levels", Value::Null).unwrap()[model["path"].as_str().unwrap()],
            3
        );
        remove(&ctx, &args).unwrap();
        assert!(first.exists() && second.exists());
        assert_eq!(list(&ctx).unwrap(), json!([]));
        assert_eq!(catalog(&ctx).unwrap().as_array().unwrap().len(), 16);
    }
}
