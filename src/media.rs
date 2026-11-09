use crate::{Ctx, Reply};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

mod catalog;
mod engine;

pub use engine::{pid, stop};
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
fn n(v: &Value, key: &str) -> u64 {
    v[key].as_u64().unwrap_or(0)
}
fn arr(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or_default()
}
fn ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}
fn ensure(p: PathBuf) -> Result<PathBuf, String> {
    fs::create_dir_all(&p).map_err(err)?;
    Ok(p)
}
fn images(ctx: &Ctx, app: &AppHandle) -> Result<PathBuf, String> {
    let settings = ctx.settings()?;
    ensure(if s(&settings, "images_dir").is_empty() {
        app.path()
            .picture_dir()
            .unwrap_or_else(|_| ctx.root.clone())
            .join("LocModel")
    } else {
        PathBuf::from(s(&settings, "images_dir"))
    })
}
fn loras(ctx: &Ctx) -> Result<PathBuf, String> {
    ensure(ctx.root.join("loras"))
}
fn ext(p: &Path) -> String {
    p.extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_lowercase()
}
fn mime(p: &Path) -> Result<&'static str, String> {
    match ext(p).as_str() {
        "png" => Ok("image/png"),
        "jpeg" | "jpg" => Ok("image/jpeg"),
        "webp" => Ok("image/webp"),
        "gif" => Ok("image/gif"),
        "bmp" => Ok("image/bmp"),
        "avif" => Ok("image/avif"),
        "webm" => Ok("video/webm"),
        _ => Err("不支持这种媒体文件".into()),
    }
}
fn decode(data: &str) -> Result<Vec<u8>, String> {
    STANDARD
        .decode(data.split_once(',').map(|(_, b)| b).unwrap_or(data))
        .map_err(err)
}
fn new_file(dir: &Path, prefix: &str, suffix: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    let mut file = tempfile::Builder::new()
        .prefix(prefix)
        .suffix(suffix)
        .tempfile_in(dir)
        .map_err(err)?;
    file.write_all(bytes).map_err(err)?;
    Ok(file.keep().map_err(err)?.1)
}
fn copy_new(from: &Path, to: &Path) -> Result<(), String> {
    if to.exists() {
        if from.canonicalize().map_err(err)? == to.canonicalize().map_err(err)? {
            return Ok(());
        }
        return Err(format!("目标文件已存在：{}", to.display()));
    }
    let mut file =
        tempfile::NamedTempFile::new_in(to.parent().ok_or("缺少目标目录")?).map_err(err)?;
    io::copy(&mut fs::File::open(from).map_err(err)?, &mut file).map_err(err)?;
    file.persist_noclobber(to).map_err(err)?;
    Ok(())
}
static HISTORY: Mutex<()> = Mutex::new(());
fn update_history(ctx: &Ctx, new: &[Value]) -> Reply {
    let _guard = HISTORY.lock().map_err(err)?;
    let mut history = ctx.read("images", json!([]))?;
    history
        .as_array_mut()
        .ok_or("作品记录格式无效")?
        .splice(0..0, new.iter().cloned());
    ctx.write("images", &history)?;
    Ok(json!(new))
}
fn delete(ctx: &Ctx, path: &Path) -> Reply {
    let _guard = HISTORY.lock().map_err(err)?;
    let mut history = ctx.read("images", json!([]))?;
    let rows = history.as_array_mut().ok_or("作品记录格式无效")?;
    let count = rows.len();
    rows.retain(|r| Path::new(s(r, "path")) != path);
    if rows.len() == count {
        return Err("作品记录中没有这个文件".into());
    }
    if !path.exists() {
        ctx.write("images", &history)?;
        return Ok(Value::Null);
    }
    let dir = tempfile::tempdir_in(path.parent().ok_or("作品路径无效")?).map_err(err)?;
    let staged = dir.path().join("deleted");
    fs::rename(path, &staged).map_err(err)?;
    if let Err(e) = ctx.write("images", &history) {
        if let Err(restore) = fs::rename(&staged, path) {
            let _ = dir.keep();
            return Err(format!(
                "{e}。还原失败：{restore}。作品保存在 {}",
                staged.display()
            ));
        }
        return Err(e);
    }
    Ok(Value::Null)
}
fn list_loras(ctx: &Ctx) -> Reply {
    let mut rows = vec![];
    for file in fs::read_dir(loras(ctx)?).map_err(err)? {
        let p = file.map_err(err)?.path();
        if p.is_file() && matches!(ext(&p).as_str(), "safetensors" | "gguf") {
            rows.push(json!({"name":p.file_stem().unwrap_or_default().to_string_lossy(),"file":p.file_name().unwrap_or_default().to_string_lossy(),"path":p,"size":p.metadata().map_err(err)?.len()}))
        }
    }
    rows.sort_by(|a, b| s(a, "name").cmp(s(b, "name")));
    Ok(json!(rows))
}
fn import_loras(ctx: &Ctx) -> Reply {
    let dir = loras(ctx)?;
    let files = rfd::FileDialog::new()
        .add_filter("LoRA", &["safetensors", "gguf"])
        .pick_files()
        .unwrap_or_default();
    let mut names = vec![];
    for p in files {
        copy_new(&p, &dir.join(p.file_name().ok_or("文件名无效")?))?;
        names.push(json!(p.file_stem().unwrap_or_default().to_string_lossy()));
    }
    Ok(json!(names))
}
fn upload(ctx: &Ctx, data: &str) -> Reply {
    let bytes = decode(data)?;
    let ext = if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        ".png"
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        ".jpg"
    } else if bytes.starts_with(b"GIF8") {
        ".gif"
    } else if bytes.get(8..12) == Some(b"WEBP") {
        ".webp"
    } else if bytes.get(4..12) == Some(b"ftypavif") || bytes.get(4..12) == Some(b"ftypavis") {
        ".avif"
    } else if bytes.starts_with(b"BM") {
        ".bmp"
    } else {
        return Err("上传的数据不是支持的图片格式".into());
    };
    Ok(json!(new_file(
        &ensure(ctx.root.join("uploads"))?,
        "upload_",
        ext,
        &bytes
    )?))
}
pub fn handle(cmd: &str, a: &Value, ctx: &Ctx, app: &AppHandle) -> Option<Reply> {
    Some(match cmd {
        "read_image" => (|| {
            let p = Path::new(s(a, "path"));
            Ok(json!(format!(
                "data:{};base64,{}",
                mime(p)?,
                STANDARD.encode(fs::read(p).map_err(err)?)
            )))
        })(),
        "images_dir_path" => images(ctx, app).map(|dir| json!(dir)),
        "open_images_dir" => images(ctx, app)
            .and_then(|dir| open::that(dir).map_err(err))
            .map(|_| Value::Null),
        "save_upload_image" => upload(ctx, s(a, "data")),
        "pick_image_files" => Ok(json!(rfd::FileDialog::new()
            .add_filter(
                "图片",
                &["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"]
            )
            .pick_files()
            .unwrap_or_default())),
        "image_history" => ctx.read("images", json!([])),
        "delete_image" => delete(ctx, Path::new(s(a, "path"))),
        "lora_dir_path" => loras(ctx).map(|dir| json!(dir)),
        "import_lora" => import_loras(ctx),
        "list_loras" => list_loras(ctx),
        _ => return catalog::handle(cmd, a, ctx, app).or_else(|| engine::handle(cmd, a, ctx, app)),
    })
}
pub use catalog::cancel_download;
