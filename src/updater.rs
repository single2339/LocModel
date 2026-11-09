use crate::{Ctx, Reply};
use reqwest::Url;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter};
use tempfile::TempDir;
use tokio::sync::watch;

static ACTIVE: Mutex<Option<watch::Sender<bool>>> = Mutex::new(None);
static READY: Mutex<Option<Package>> = Mutex::new(None);

fn portable_at(dir: &Path) -> Option<PathBuf> {
    let data = dir.join("LocModelData");
    if !(dir.join("portable.txt").is_file() || dir.join("portable").exists() || data.is_dir()) {
        return None;
    }
    fs::create_dir_all(&data).ok()?;
    tempfile::Builder::new()
        .prefix(".write-test")
        .tempfile_in(&data)
        .ok()?;
    Some(data)
}

pub fn portable_root() -> Option<PathBuf> {
    if !cfg!(windows) {
        return None;
    }
    portable_at(std::env::current_exe().ok()?.parent()?)
}

fn platform() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => "win",
        ("macos", _) => "mac",
        ("linux", "aarch64") => "linux_arm64",
        ("linux", "x86_64") => "linux",
        _ => "",
    }
}

fn allowed(url: &Url) -> bool {
    let official = url.scheme() == "https"
        && matches!(
            url.host_str(),
            Some("www.locmodel.com" | "locmodel.com" | "get.locmodel.com")
        )
        && url.port().is_none();
    let fixture = cfg!(test) && url.scheme() == "http" && url.host_str() == Some("127.0.0.1");
    (official || fixture)
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
}

fn release_version(text: &str) -> Option<Vec<u64>> {
    let mut parts: Vec<u64> = text
        .trim_start_matches(['v', 'V'])
        .split(['.', '-'])
        .map(str::parse)
        .collect::<Result<_, _>>()
        .ok()?;
    while parts.last() == Some(&0) {
        parts.pop();
    }
    Some(parts)
}

struct Release {
    url: Url,
    key: &'static str,
    hash: Option<String>,
}

fn release(manifest: &Value, args: &Value, key: &'static str) -> Result<Release, String> {
    let version = manifest["version"]
        .as_str()
        .and_then(release_version)
        .ok_or("官方版本号无效")?;
    if key.is_empty()
        || version <= release_version(env!("CARGO_PKG_VERSION")).unwrap()
        || manifest["version"] != args["version"]
        || manifest[key] != args["url"]
    {
        return Err("此安装包与当前平台的新版发布记录不符".into());
    }
    let url =
        Url::parse(manifest[key].as_str().ok_or("没有可用的安装包")?).map_err(|e| e.to_string())?;
    let suffix = match key {
        "win" => ".exe",
        "mac" => ".dmg",
        _ => ".zip",
    };
    if !allowed(&url) || !url.path().to_ascii_lowercase().ends_with(suffix) {
        return Err("安装包来源或格式不受支持".into());
    }
    let hash = manifest["sha256"]
        .get(key)
        .or_else(|| manifest.get(format!("{key}_sha256")))
        .map(|v| {
            v.as_str()
                .filter(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
                .map(str::to_ascii_lowercase)
                .ok_or("发布记录的 SHA-256 无效")
        })
        .transpose()?;
    Ok(Release { url, key, hash })
}

struct Package {
    dir: TempDir,
    path: PathBuf,
    hash: String,
    key: &'static str,
}

impl Package {
    fn check(&self, path: &str) -> Result<File, String> {
        if Path::new(path) != self.path || !fs::symlink_metadata(&self.path).map_err(err)?.is_file()
        {
            return Err("请选择本次下载的安装包".into());
        }
        let mut digest = Sha256::new();
        let mut options = File::options();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(1); // FILE_SHARE_READ prevents writes and deletion through launch.
        }
        let mut file = options.open(&self.path).map_err(err)?;
        io::copy(&mut file, &mut digest).map_err(err)?;
        if format!("{:x}", digest.finalize()) != self.hash {
            return Err("安装包已改变，请重新下载".into());
        }
        Ok(file)
    }
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn check_format(file: &mut File, key: &str) -> Result<(), String> {
    let (offset, magic): (_, &[u8]) = match key {
        "win" => (SeekFrom::Start(0), b"MZ"),
        "mac" => (SeekFrom::End(-512), b"koly"),
        _ => (SeekFrom::Start(0), b"PK\x03\x04"),
    };
    file.seek(offset).map_err(err)?;
    let mut head = [0u8; 4];
    file.read_exact(&mut head[..magic.len()]).map_err(err)?;
    if &head[..magic.len()] != magic {
        return Err("安装包格式无效".into());
    }
    Ok(())
}

fn http() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::custom(|next| {
            if next.previous().len() < 5 && allowed(next.url()) {
                next.follow()
            } else {
                next.error("更新重定向被拒绝")
            }
        }))
        .connect_timeout(Duration::from_secs(12))
        .read_timeout(Duration::from_secs(45))
        .build()
        .map_err(err)
}

async fn transfer(
    release: Release,
    mut progress: impl FnMut(u64, u64, f64),
) -> Result<Package, String> {
    let client = http()?;
    let mut response = client
        .get(release.url)
        .send()
        .await
        .map_err(err)?
        .error_for_status()
        .map_err(err)?;
    if response.status() != reqwest::StatusCode::OK {
        return Err("安装包响应不完整".into());
    }
    let total = response.content_length().unwrap_or(0);
    let mut builder = tempfile::Builder::new();
    builder.prefix("LocModel-update-");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        builder.permissions(fs::Permissions::from_mode(0o700));
    }
    let dir = builder.tempdir().map_err(err)?;
    let filename = match release.key {
        "win" => "LocModel-update.exe",
        "mac" => "LocModel-update.dmg",
        _ => "LocModel-update.zip",
    };
    let path = dir.path().join(filename);
    let mut file = File::options()
        .read(true)
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(err)?;
    let start = Instant::now();
    let mut last = start;
    let mut done = 0;
    let mut digest = Sha256::new();
    progress(0, total, 0.0);
    while let Some(chunk) = response.chunk().await.map_err(err)? {
        file.write_all(&chunk).map_err(err)?;
        digest.update(&chunk);
        done += chunk.len() as u64;
        if last.elapsed() >= Duration::from_millis(160) {
            progress(done, total, done as f64 / start.elapsed().as_secs_f64());
            last = Instant::now();
        }
    }
    if done == 0 || (total != 0 && done != total) {
        return Err("安装包下载不完整".into());
    }
    let hash = format!("{:x}", digest.finalize());
    if release.hash.is_some_and(|expected| expected != hash) {
        return Err("安装包 SHA-256 校验失败".into());
    }
    file.sync_all().map_err(err)?;
    check_format(&mut file, release.key)?;
    progress(done, total, done as f64 / start.elapsed().as_secs_f64());
    Ok(Package {
        dir,
        path,
        hash,
        key: release.key,
    })
}

async fn manifest(bases: &[&str]) -> Reply {
    let client = http()?;
    for base in bases {
        let request = client
            .get(format!("{base}/api.php?act=client_config"))
            .timeout(Duration::from_secs(8));
        if let Ok(response) = request.send().await {
            if response.status() == reqwest::StatusCode::OK {
                if let Ok(config) = response.json::<Value>().await {
                    if config["update"].is_object() {
                        return Ok(config["update"].clone());
                    }
                }
            }
        }
    }
    Err("无法获取官方更新记录".into())
}

async fn cancellable(
    task: impl std::future::Future<Output = Result<Package, String>>,
    mut cancel: watch::Receiver<bool>,
) -> Result<Package, String> {
    tokio::select! {
        biased;
        _ = cancel.changed() => Err("已取消".into()),
        result = task => result,
    }
}

fn download(args: &Value, app: &AppHandle) -> Reply {
    if portable_root().is_some() {
        return Err("便携版请从官网下载页更新".into());
    }
    let (sender, cancel) = watch::channel(false);
    {
        let mut active = ACTIVE.lock().unwrap();
        if active.is_some() {
            return Err("更新正在下载".into());
        }
        *active = Some(sender);
        READY.lock().unwrap().take();
    }
    let task = async {
        // The account service can be customized. Only the publisher can authorize an installer.
        let config = manifest(&crate::account::BASES).await?;
        let release = release(&config, args, platform())?;
        transfer(release, |done, total, speed| {
            let _ = app.emit(
                "download-progress",
                json!({
                    "id":"update","status":"downloading","done":done,"total":total,
                    "speed":speed,"file_index":0,"file_count":1
                }),
            );
        })
        .await
    };
    let result = tauri::async_runtime::block_on(cancellable(task, cancel));
    let mut active = ACTIVE.lock().unwrap();
    if active.take().is_some_and(|s| *s.borrow()) {
        return Err("已取消".into());
    }
    let package = result?;
    let value = json!(package.path);
    *READY.lock().unwrap() = Some(package);
    Ok(value)
}

fn installer(key: &str, path: &Path) -> Command {
    match key {
        "win" => Command::new(path),
        "mac" => {
            let mut c = Command::new("/usr/bin/open");
            c.arg(path);
            c
        }
        _ => {
            let mut c = Command::new("xdg-open");
            c.arg(path);
            c
        }
    }
}

fn install(args: &Value, app: &AppHandle) -> Reply {
    if args["officialConfirmed"] != true || portable_root().is_some() {
        return Err("请先确认安装官方版本".into());
    }
    let mut ready = READY.lock().unwrap();
    let package = ready.as_ref().ok_or("请先下载官方安装包")?;
    let _verified_file = package.check(args["path"].as_str().ok_or("缺少安装包路径")?)?;
    installer(package.key, &package.path).spawn().map_err(err)?;
    let exit = package.key == "win";
    // Archive viewers and installers can open the path after the launcher returns.
    let _path = ready.take().unwrap().dir.keep();
    if exit {
        app.exit(0);
    }
    Ok(Value::Null)
}

pub fn handle(cmd: &str, a: &Value, _ctx: &Ctx, app: &AppHandle) -> Option<Reply> {
    Some(match cmd {
        "update_platform" => Ok(json!(platform())),
        "is_portable" => Ok(json!(portable_root().is_some())),
        "download_update" => download(a, app),
        "install_update" => install(a, app),
        "cancel_download" if a["id"] == "update" => {
            if let Some(sender) = ACTIVE.lock().unwrap().as_ref() {
                sender.send_replace(true);
            }
            Ok(Value::Null)
        }
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::thread;

    fn serve(reply: Vec<u8>) -> (Url, thread::JoinHandle<()>) {
        let server = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let url = Url::parse(&format!(
            "http://{}/release.exe",
            server.local_addr().unwrap()
        ))
        .unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = server.accept().unwrap();
            let mut request = [0u8; 4096];
            assert!(stream.read(&mut request).unwrap() > 0);
            stream.write_all(&reply).unwrap();
        });
        (url, server)
    }

    fn payload(body: &[u8]) -> Vec<u8> {
        let mut response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        response.extend(body);
        response
    }

    #[test]
    fn official_manifest_binds_channel_version_url_platform() {
        let url = "https://www.locmodel.com/release.exe";
        let mut manifest = json!({"version":"3.2.0","win":url});
        let args = json!({"version":"3.2.0","url":url});
        assert!(release(&manifest, &args, "win").is_ok());
        assert!(release(&manifest, &args, "mac").is_err());
        assert!(release(
            &manifest,
            &json!({"version":"3.2.0","url":"https://example.com/payload.exe"}),
            "win"
        )
        .is_err());
        for bad in [
            "https://www.locmodel.com.example.org/release.exe",
            "http://www.locmodel.com/release.exe",
            "file:///tmp/release.exe",
            "https://user@www.locmodel.com/release.exe",
            "https://www.locmodel.com/release.zip",
        ] {
            manifest["win"] = json!(bad);
            assert!(release(&manifest, &json!({"version":"3.2.0","url":bad}), "win").is_err());
        }
        assert!(release(
            &json!({"version":"3.1.0","win":url}),
            &json!({"version":"3.1.0","url":url}),
            "win"
        )
        .is_err());
    }

    #[test]
    fn download_reports_progress_and_rejects_tampering() {
        let body = b"MZfixture installer";
        let (url, server) = serve(payload(body));
        let (mut done, mut total) = (0, 0);
        let package = tauri::async_runtime::block_on(transfer(
            Release {
                url,
                key: "win",
                hash: Some(format!("{:x}", Sha256::digest(body))),
            },
            |d, t, _| {
                done = d;
                total = t
            },
        ))
        .unwrap();
        server.join().unwrap();
        assert_eq!((done, total), (body.len() as u64, body.len() as u64));
        assert!(package.check("/tmp/another.exe").is_err());
        assert!(package.check(package.path.to_str().unwrap()).is_ok());
        fs::write(&package.path, b"MZmodified").unwrap();
        assert!(package.check(package.path.to_str().unwrap()).is_err());
        let path = package.path.clone();
        drop(package);
        assert!(!path.exists());
    }

    #[test]
    fn publisher_metadata_and_package_use_separate_requests() {
        let body = b"MZfixture official installer";
        let (asset, asset_server) = serve(payload(body));
        let metadata = json!({"update":{"version":"3.2.0","win":asset.as_str(),"win_sha256":format!("{:x}",Sha256::digest(body))}});
        let (origin, manifest_server) = serve(payload(&serde_json::to_vec(&metadata).unwrap()));
        let base = origin.origin().ascii_serialization();
        tauri::async_runtime::block_on(async {
            let update = manifest(&[&base]).await.unwrap();
            let args = json!({"version":"3.2.0","url":asset.as_str()});
            let package = transfer(release(&update, &args, "win").unwrap(), |_, _, _| {})
                .await
                .unwrap();
            assert!(package.check(package.path.to_str().unwrap()).is_ok());
        });
        manifest_server.join().unwrap();
        asset_server.join().unwrap();
    }

    #[test]
    fn rejects_bad_checksum_bad_format_and_insecure_redirect() {
        for (response,hash) in [
            (payload(b"MZfixture"),Some("0".repeat(64))),
            (payload(b"<html>"),None),
            (b"HTTP/1.1 302 Found\r\nLocation: http://www.locmodel.com/unsafe.exe\r\nContent-Length: 0\r\n\r\n".to_vec(),None),
        ] {
            let (url,server)=serve(response);
            let result=tauri::async_runtime::block_on(transfer(Release{url,key:"win",hash},|_,_,_|{}));
            assert!(result.is_err());
            server.join().unwrap();
        }
    }

    #[test]
    fn cancels_a_stalled_download() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let url = Url::parse(&format!(
            "http://{}/release.exe",
            listener.local_addr().unwrap()
        ))
        .unwrap();
        let (cancel, rx) = watch::channel(false);
        let (finished, wait) = std::sync::mpsc::channel();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 1024];
            assert!(stream.read(&mut request).unwrap() > 0);
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1200\r\n\r\nMZ")
                .unwrap();
            wait.recv_timeout(Duration::from_secs(5)).unwrap();
        });
        let task = transfer(
            Release {
                url,
                key: "win",
                hash: None,
            },
            |_, _, _| {
                cancel.send_replace(true);
            },
        );
        let result = tauri::async_runtime::block_on(cancellable(task, rx));
        assert!(matches!(result,Err(ref message) if message == "已取消"));
        finished.send(()).unwrap();
        server.join().unwrap();
    }

    #[test]
    fn portable_marker_and_installer_commands() {
        let exe_dir = tempfile::tempdir().unwrap();
        assert_eq!(portable_at(exe_dir.path()), None);
        fs::write(exe_dir.path().join("portable.txt"), "").unwrap();
        let data = exe_dir.path().join("LocModelData");
        assert_eq!(portable_at(exe_dir.path()), Some(data.clone()));
        fs::remove_file(exe_dir.path().join("portable.txt")).unwrap();
        assert_eq!(portable_at(exe_dir.path()), Some(data));
        let path = Path::new("/staging/installer file");
        for (key, program) in [
            ("win", path.to_str().unwrap()),
            ("mac", "/usr/bin/open"),
            ("linux", "xdg-open"),
        ] {
            let cmd = installer(key, path);
            assert_eq!(cmd.get_program(), std::ffi::OsStr::new(program));
            assert_eq!(
                cmd.get_args().collect::<Vec<_>>(),
                if key == "win" {
                    vec![]
                } else {
                    vec![path.as_os_str()]
                }
            );
        }
    }
}
